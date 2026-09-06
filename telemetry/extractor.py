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
from .exceptions import UpstreamError
from .mapping import DriftReporter
from .metrics import Metrics
from .repository import TelemetryRepository, WriteResult
from .schemas import (
    ParsedVehicle,
    ValidatedPayload,
    VehiclesPayload,
    count_active_vehicles,
    merge_vehicle_frames,
    parse_payload,
    report_dates,
)

log = logging.getLogger(__name__)


@dataclass(slots=True)
class DateResolution:
    """What the live-date resolver decided for a tier-1 batch, and why.

    The upstream keys every fleet batch on a `date` query parameter (default:
    today, IST).  When the configured date -- or the server default -- returns
    an empty or dead batch, the resolver probes for the freshest date that
    actually holds a live fleet and remembers the decision here so later
    cycles can retain it while checking for newer reporting dates.

    `source` values:
      * `configured`     -- `API_DATE` as given carried a live batch;
      * `server-default` -- omitting `date` (upstream's today-IST) carried one;
      * `report-date`    -- a date read off the fleet's own `last_updated`;
      * `walkback`       -- a day from the recent-past walk-back tier.
    `satisfied=False` marks a *best-effort* decision: nothing reached the
    threshold, and the batch with the most active vehicles was kept rather
    than returning (and ingesting) an empty payload.
    """

    configured_date: str | None
    resolved_date: str | None
    source: str
    active_vehicles: int
    probes: int
    satisfied: bool
    resolved_at: float
    probe_errors: int = 0


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
    resolved_date: str | None = None
    date_source: str = ""
    date_probes: int = 0
    date_probe_errors: int = 0
    date_satisfied: bool = True
    active_vehicles: int = 0
    newest_observed_at: datetime | None = None
    missing_timestamps: int = 0

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
        if self.date_source:
            base += (
                f" | date={self.resolved_date or '<server default>'} "
                f"({self.date_source}, {self.date_probes} probe(s), {self.date_probe_errors} errors, "
                f"active={self.active_vehicles}, satisfied={self.date_satisfied})"
            )
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
        # The live-date decision of the most recent tier-1 fetch (see below).
        self._date_plan: DateResolution | None = None

    @property
    def date_resolution(self) -> DateResolution | None:
        """The live-date decision behind the most recent tier-1 fetch."""
        return self._date_plan

    # ------------------------------------------------------------------ API
    def run_cycle(self, session: Session, *, now: datetime | None = None) -> CycleReport:
        ingested_at = now or datetime.now(timezone.utc)
        started = time.perf_counter()
        report = CycleReport(started_at=ingested_at, ingested_at=ingested_at)

        raw = self._fetch()
        if self._date_plan is not None:
            report.resolved_date = self._date_plan.resolved_date
            report.date_source = self._date_plan.source
            report.date_probes = self._date_plan.probes
            report.date_probe_errors = self._date_plan.probe_errors
            report.date_satisfied = self._date_plan.satisfied
            report.active_vehicles = self._date_plan.active_vehicles
        payload = self._validate_envelope(raw)
        payload, report.detail_ok, report.detail_failed = self._enrich_with_details(payload)
        validated = self._validate_vehicles(payload, ingested_at)

        report.seen = validated.seen
        report.accepted = validated.accepted
        report.rejected = len(validated.rejected)
        report.rejected_ids = [r.vehicle_id for r in validated.rejected][:20]
        # Ingest-time fallbacks may key history, but are not evidence that the
        # upstream sent a new observation. Keep them out of freshness diagnostics.
        timestamped = [v for v in validated.ok if v.observed_at is not None
                       and not any(e.field == "last_updated" for e in v.field_errors)]
        report.missing_timestamps = len(validated.ok) - len(timestamped)
        report.newest_observed_at = max((v.observed_at for v in timestamped), default=None)

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
        """Check the current feed every poll; never pin a healthy archive forever.

        Explicit API_DATE remains an intentional filter. With fallback enabled,
        a historical winner is re-resolved each cycle so newer data can win even
        while yesterday's fleet is still healthy. Only *best-effort* full
        searches are throttled by LIVE_DATE_REPROBE_SECONDS.
        """
        now = time.monotonic()
        if not self.settings.live_date_fallback:
            raw = self._fetch_date(self.settings.api_date)
            active = count_active_vehicles(raw)
            self._date_plan = DateResolution(
                configured_date=self.settings.api_date,
                resolved_date=self.settings.api_date,
                source="configured" if self.settings.api_date else "server-default",
                active_vehicles=active, probes=1,
                satisfied=active >= self.settings.live_date_min_vehicles,
                resolved_at=now,
            )
            return raw
        raw, self._date_plan = self._resolve_live_date(now)
        return raw

    def _fetch_date(self, date: str | None, *, label: str = "vehicles") -> dict[str, Any]:
        """One tier-1 GET pinned to `date` (None = omit the parameter entirely)."""
        return run_with_reauth(  # type: ignore[return-value]
            self.tokens,
            lambda token: self.client.fetch_vehicles(token, date=date),
            label=label,
        )

    def _resolve_live_date(self, now: float) -> tuple[dict[str, Any], DateResolution]:
        """Bounded, newest-first search, counting FAILED attempts in the budget.

        Try the explicit filter (if set), then the server default. Merge recent
        calendar days and reporting hints in descending date order. Reserve the
        final probe for the newest known reporting hint/cached date if a small
        budget would otherwise never reach it. The outcome is the freshest
        qualifying batch *examined*, not a claim to have searched every date.
        """
        settings = self.settings
        threshold = settings.live_date_min_vehicles
        configured = settings.api_date
        previous = self._date_plan
        today = datetime.now(settings.tz).date()
        tried: set[str | None] = set()
        hints: set[str] = set()
        if previous and previous.resolved_date:
            hints.add(previous.resolved_date)
        best: tuple[dict[str, Any], str | None, str, int] | None = None
        last_error: UpstreamError | None = None
        probes = errors = 0

        def probe(date: str | None, source: str) -> bool:
            nonlocal probes, errors, best, last_error
            if date in tried or probes >= settings.live_date_max_probes:
                return False
            tried.add(date)
            probes += 1  # errors cost upstream requests too
            try:
                raw = self._fetch_date(date)
            except UpstreamError as exc:
                last_error = exc
                errors += 1
                log.warning("live-date: date=%s via %s failed (%s, HTTP %s)",
                            date or "<server default>", source, type(exc).__name__, exc.status_code)
                return False
            active = count_active_vehicles(raw)
            log.info("live-date: date=%s via %s -> %d active vehicle(s) (threshold %d, probe %d/%d)",
                     date or "<server default>", source, active, threshold, probes, settings.live_date_max_probes)
            # Preserve the richest thin batch if no candidate reaches the threshold.
            if best is None or active > best[3] or active >= threshold:
                best = (raw, date, source, active)
            hints.update(d for d in report_dates(raw, settings.tz) if d <= today.isoformat())
            return active >= threshold

        def finish(*, reused: bool = False) -> tuple[dict[str, Any], DateResolution]:
            if best is None:
                raise last_error or UpstreamError("live-date resolution made no successful request")
            raw, date, source, active = best
            plan = DateResolution(
                configured_date=configured, resolved_date=date, source=source,
                active_vehicles=active, probes=probes, probe_errors=errors,
                satisfied=active >= threshold,
                resolved_at=previous.resolved_at if reused and previous else now,
            )
            log.log(logging.INFO if plan.satisfied else logging.WARNING,
                    "live-date: resolved=%s source=%s active=%d satisfied=%s probes=%d errors=%d%s",
                    date or "<server default>", source, active, plan.satisfied, probes, errors,
                    " (best-effort cooldown)" if reused else "")
            return raw, plan

        if configured and probe(configured, "configured"):
            return finish()
        if probe(None, "server-default"):
            return finish()

        # Even while a full best-effort search is cooling down, today was
        # checked above. A newly available current fleet is never hidden by it.
        if previous and not previous.satisfied and now - previous.resolved_at < settings.live_date_reprobe_seconds:
            if previous.resolved_date not in tried:
                probe(previous.resolved_date, previous.source)
            return finish(reused=True)

        days = {(today - timedelta(days=i)).isoformat() for i in range(settings.live_date_probe_days)}
        while probes < settings.live_date_max_probes:
            remaining = (days | hints) - tried
            if not remaining:
                break
            known = hints - tried
            # Don't discard a known fleet just because the archive is beyond
            # the current budget. Newer candidates still get every earlier slot.
            date = max(known) if settings.live_date_max_probes - probes == 1 and known else max(remaining)
            if probe(date, "report-date" if date in hints else "walkback"):
                return finish()
        return finish()

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
                        "%s: tier-2 detail fetch failed (%s) -- keeping fleet-summary frame",
                        vehicle_id,
                        exc.__class__.__name__,
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
