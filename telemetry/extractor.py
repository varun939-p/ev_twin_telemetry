"""One extraction cycle: fetch -> validate -> write.

This module is deliberately free of scheduling, signal handling and token
politics.  Given a token manager and a session, `TelemetryExtractor.run_cycle()`
performs exactly one poll and returns what happened.  That makes it directly
unit-testable and reusable from the `once` CLI command.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

from sqlalchemy.orm import Session

from .api import UpstreamClient
from .auth import TokenManager, run_with_reauth
from .config import Settings
from .mapping import DriftReporter
from .metrics import Metrics
from .repository import TelemetryRepository, WriteResult
from .schemas import (
    ParsedVehicle,
    ValidatedPayload,
    VehiclesPayload,
    merge_vehicle_frames,
    parse_payload,
)

log = logging.getLogger(__name__)


@dataclass(slots=True)
class CycleReport:
    """Everything one cycle did, for logging and metrics."""

    started_at: datetime
    ingested_at: datetime
    duration_ms: float = 0.0
    seen: int = 0
    accepted: int = 0
    rejected: int = 0
    rejected_ids: list[str] = field(default_factory=list)
    field_errors: int = 0
    missing_params: int = 0
    detail_ok: int = 0
    detail_failed: int = 0
    write: WriteResult = field(default_factory=WriteResult)
    stale: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.accepted > 0 or self.seen == 0

    def summary(self) -> str:
        base = (
            f"cycle in {self.duration_ms:.0f}ms: seen={self.seen} accepted={self.accepted} "
            f"rejected={self.rejected} field_errors={self.field_errors} | {self.write.as_log()}"
        )
        if self.detail_ok or self.detail_failed:
            base += f" | detail ok={self.detail_ok} failed={self.detail_failed}"
        return base


class TelemetryExtractor:
    def __init__(
        self,
        settings: Settings,
        client: UpstreamClient,
        tokens: TokenManager,
        metrics: Metrics | None = None,
        drift: DriftReporter | None = None,
    ) -> None:
        self.settings = settings
        self.client = client
        self.tokens = tokens
        self.metrics = metrics or Metrics()
        self.drift = drift or DriftReporter()
        # vehicle_id -> signature of the last reading we persisted
        self._last_signature: dict[str, str] = {}

    # ------------------------------------------------------------------ API
    def run_cycle(self, session: Session, *, now: datetime | None = None) -> CycleReport:
        ingested_at = now or datetime.now(timezone.utc)
        started = time.perf_counter()
        report = CycleReport(started_at=ingested_at, ingested_at=ingested_at)

        raw = self._fetch()
        payload = self._validate_envelope(raw)
        payload, report.detail_ok, report.detail_failed = self._enrich_with_details(payload)
        validated = self._validate_vehicles(payload, ingested_at)

        report.seen = validated.seen
        report.accepted = validated.accepted
        report.rejected = len(validated.rejected)
        report.rejected_ids = [r.vehicle_id for r in validated.rejected][:20]

        self._report_quality(validated, report)

        unchanged = self._detect_unchanged(validated.ok)
        repo = TelemetryRepository(session)
        report.write = repo.write_cycle(validated.ok, ingested_at=ingested_at, unchanged_ids=unchanged)
        session.commit()

        report.stale = self._stale_vehicles(repo, ingested_at)
        report.duration_ms = (time.perf_counter() - started) * 1000.0

        self._remember(validated.ok)
        self._publish(report)
        log.info(report.summary())
        return report

    # -------------------------------------------------------------- private
    def _fetch(self) -> dict[str, Any]:
        """GET the tier-1 fleet summary, re-authenticating once if the token died."""
        return run_with_reauth(  # type: ignore[return-value]
            self.tokens,
            self.client.fetch_vehicles,
            label="vehicles",
        )

    def _fetch_detail(self, vehicle_id: str) -> dict[str, Any]:
        """GET one vehicle's tier-2 live diagnostic frame (runs in a worker thread)."""
        return run_with_reauth(  # type: ignore[return-value]
            self.tokens,
            lambda token: self.client.fetch_vehicle(token, vehicle_id),
            label=f"vehicle {vehicle_id}",
        )

    def _enrich_with_details(self, payload: VehiclesPayload) -> tuple[VehiclesPayload, int, int]:
        """Tier 2: fetch `/api/v1/vehicles/{id}` for every vehicle, concurrently.

        The tier-1 summary intentionally carries `"battery": null`; the live
        battery telemetry lives on the per-vehicle detail endpoint.  Detail
        frames are merged into their summary frames (`merge_vehicle_frames`)
        before validation.

        Failure isolation: one truck's detail fetch failing (404, timeout,
        revoked-token edge) keeps that truck's summary frame and logs loudly --
        it can never sink the cycle or the fleet.  Returns
        `(payload, ok_count, failed_count)`.
        """
        if not self.settings.detail_fetch_enabled or not payload.vehicles:
            return payload, 0, 0

        vehicle_ids = list(payload.vehicles)
        workers = min(self.settings.detail_fetch_workers, len(vehicle_ids))
        log.info(
            "tier 2: fetching live detail for %d vehicle(s) with %d worker(s)",
            len(vehicle_ids),
            workers,
        )

        ok = failed = 0
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="vehicle-detail") as pool:
            futures = {pool.submit(self._fetch_detail, vehicle_id): vehicle_id for vehicle_id in vehicle_ids}
            for future in as_completed(futures):
                vehicle_id = futures[future]
                try:
                    detail = future.result()
                except Exception as exc:  # noqa: BLE001 -- one truck must not sink the fleet
                    failed += 1
                    log.warning(
                        "%s: tier-2 detail fetch failed (%s: %s) -- keeping fleet-summary frame",
                        vehicle_id,
                        exc.__class__.__name__,
                        exc,
                    )
                    continue
                payload.vehicles[vehicle_id] = merge_vehicle_frames(payload.vehicles[vehicle_id], detail)
                ok += 1

        self.metrics.inc("twin_detail_requests_total", value=float(ok))
        self.metrics.inc("twin_detail_failures_total", value=float(failed))
        if failed:
            log.warning("tier 2: %d/%d detail fetch(es) failed this cycle", failed, ok + failed)
        return payload, ok, failed

    @staticmethod
    def _validate_envelope(raw: dict[str, Any]) -> VehiclesPayload:
        return VehiclesPayload.model_validate(raw)

    def _validate_vehicles(self, payload: VehiclesPayload, ingested_at: datetime) -> ValidatedPayload:
        return parse_payload(
            payload,
            self.settings.tz,
            require_all_fields=self.settings.require_all_fields,
            ingest_time=ingested_at,
            fallback_observed_at=self.settings.fallback_observed_at,
        )

    def _report_quality(self, validated: ValidatedPayload, report: CycleReport) -> None:
        for vehicle in validated.ok:
            # Log the first occurrence of each distinct payload shape.
            raw_frame = {k: v for k, v in vehicle.values.items() if v is not None}
            self.drift.observe(vehicle.vehicle_id, raw_frame)
            report.field_errors += len(vehicle.field_errors)
            report.missing_params += len(vehicle.missing)
            for err in vehicle.field_errors[:3]:
                log.warning(
                    "%s: field %s unusable (%s) raw=%r -> stored NULL",
                    vehicle.vehicle_id,
                    err.field,
                    err.error,
                    err.raw,
                )

        for rejected in validated.rejected[:5]:
            log.error(
                "%s: frame rejected -- %s%s",
                rejected.vehicle_id,
                rejected.reason,
                f" ({len(rejected.errors)} field error(s))" if rejected.errors else "",
            )
            self.metrics.inc("twin_vehicles_rejected_total", reason=rejected.reason.split(":")[0][:40])

        if validated.seen == 0:
            log.warning(
                "upstream returned an empty `vehicles` object -- "
                "check the client's customer scoping or the ?date parameter"
            )

    def _detect_unchanged(self, vehicles: Sequence[ParsedVehicle]) -> list[str]:
        """Vehicles whose reading is identical to the last one we stored.

        An idle truck reports the same frame every poll for hours.  Writing that
        to history again is pure write amplification, so we skip it -- the
        dimension table's `last_seen` still advances, so "we saw it" is recorded.
        """
        if self.settings.write_unchanged:
            return []
        return [v.vehicle_id for v in vehicles if self._last_signature.get(v.vehicle_id) == v.signature()]

    def _remember(self, vehicles: Sequence[ParsedVehicle]) -> None:
        for vehicle in vehicles:
            self._last_signature[vehicle.vehicle_id] = vehicle.signature()

    def _stale_vehicles(self, repo: TelemetryRepository, ingested_at: datetime) -> list[str]:
        threshold = ingested_at - timedelta(seconds=max(60.0, self.settings.poll_interval_seconds * 3))
        try:
            stale = repo.stale_vehicles(threshold)
        except Exception as exc:  # pragma: no cover - diagnostics must not break the cycle
            log.debug("staleness check failed: %s", exc)
            return []
        if stale:
            log.warning(
                "%d vehicle(s) have not reported since %s: %s",
                len(stale),
                threshold.isoformat(timespec="seconds"),
                ", ".join(stale[:10]),
            )
        return stale

    def _publish(self, report: CycleReport) -> None:
        m = self.metrics
        m.inc("twin_cycles_total")
        m.set_gauge("twin_vehicles_seen", report.seen)
        m.set_gauge("twin_vehicles_written", report.write.states_written)
        m.inc("twin_history_rows_total", report.write.history_written)
        m.set_gauge("twin_cycle_duration_seconds", report.duration_ms / 1000.0)
        m.set_gauge("twin_last_successful_cycle_timestamp_seconds", report.ingested_at.timestamp())
        m.set_gauge("twin_token_seconds_until_refresh", self.tokens.seconds_until_refresh)

    # ------------------------------------------------------------- one-shot
    def fetch_only(self) -> VehiclesPayload:
        """Fetch (both tiers) without touching the database (used by `once --dry-run`)."""
        payload = self._validate_envelope(self._fetch())
        enriched, _, _ = self._enrich_with_details(payload)
        return enriched
