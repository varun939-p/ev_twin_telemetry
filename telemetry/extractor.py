"""One extraction cycle: fetch -> validate -> write.

This module is deliberately free of scheduling, signal handling and token
politics.  Given a token manager and a session, `TelemetryExtractor.run_cycle()`
performs exactly one poll and returns what happened.  That makes it directly
unit-testable and reusable from the `once` CLI command.
"""

from __future__ import annotations

import logging
import time
from collections import deque
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
    cycles go straight to it instead of re-probing every poll.

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
                f"({self.date_source}, {self.date_probes} probe(s))"
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
        """GET the tier-1 fleet summary, re-authenticating once if the token died.

        Wraps the live-date resolution: a batch that carries fewer active
        vehicles than `Settings.live_date_min_vehicles` triggers a bounded
        probe for the freshest date that does hold a live fleet (`API_DATE`
        omitted or stale must never mean an empty ingest).  The winning
        decision is cached in `self._date_plan` so steady-state polls send a
        single tier-1 GET, exactly as before this existed.
        """
        now = time.monotonic()
        plan = self._date_plan
        if plan is None:
            if not self.settings.live_date_fallback:
                # Opt-out: behave exactly like the pre-resolution engine -- one
                # tier-1 GET with whatever API_DATE says, dead batch or not.
                raw = self._fetch_date(self.settings.api_date)
                active = count_active_vehicles(raw)
                self._date_plan = DateResolution(
                    configured_date=self.settings.api_date,
                    resolved_date=self.settings.api_date,
                    source="configured",
                    active_vehicles=active,
                    probes=1,
                    satisfied=active >= self.settings.live_date_min_vehicles,
                    resolved_at=now,
                )
                return raw
            raw, self._date_plan = self._resolve_live_date(now)
            return raw
        if not self.settings.live_date_fallback:
            return self._fetch_date(plan.resolved_date, label="vehicles")
        raw = self._fetch_date(plan.resolved_date, label="vehicles")
        active = count_active_vehicles(raw)
        if active >= self.settings.live_date_min_vehicles:
            self._date_plan = DateResolution(
                configured_date=plan.configured_date,
                resolved_date=plan.resolved_date,
                source=plan.source,
                active_vehicles=active,
                probes=1,
                satisfied=True,
                resolved_at=now,
            )
            return raw
        if plan.satisfied:
            log.warning(
                "live-date: cached date %s degraded to %d active vehicle(s) -- re-resolving",
                plan.resolved_date or "<server default>",
                active,
            )
        elif now - plan.resolved_at < self.settings.live_date_reprobe_seconds:
            # The last resolution already spent its probe budget and found
            # nothing better; re-probing every poll would be a probe storm.
            log.debug(
                "live-date: reusing best-effort batch (%d active) inside the %.0fs reprobe window",
                active,
                self.settings.live_date_reprobe_seconds,
            )
            return raw
        else:
            log.info("live-date: reprobe window elapsed -- looking for a fresher batch")
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
        """Find the freshest tier-1 batch that holds a live fleet.

        Probe tiers, newest first, bounded by `live_date_max_probes`:

        1. the configured `API_DATE` (when set), then the upstream's own
           server-default (date omitted) -- the two cheapest, most likely hits;
        2. dates read off the fleet's `last_updated` values of any batch seen
           so far (`report_dates`) -- the upstream telling us where its data is;
        3. a walk back from today (source-local) over `live_date_probe_days`.

        The first batch reaching `live_date_min_vehicles` active vehicles wins.
        If nothing reaches it, the batch with the *most* active vehicles wins
        anyway: ingesting a thin batch and reporting the gap honestly beats
        returning -- and persisting -- an empty payload.  A probe that fails
        outright (4xx, exhausted 5xx retries) is skipped, never fatal: one bad
        date must not cost the cycle.  If *every* probe fails, the last
        transport error is re-raised so the orchestrator handles it as the
        upstream outage it is.
        """
        settings = self.settings
        threshold = settings.live_date_min_vehicles
        configured = settings.api_date

        queue: deque[tuple[str | None, str]] = deque()
        queue.append((configured, "configured" if configured else "server-default"))
        if configured:
            queue.append((None, "server-default"))
        tried: set[str | None] = set()
        walkback_queued = False
        best: tuple[dict[str, Any], str | None, str, int] | None = None
        last_error: UpstreamError | None = None
        probes = 0

        while queue and probes < settings.live_date_max_probes:
            date, source = queue.popleft()
            if date in tried:
                continue
            tried.add(date)
            try:
                raw = self._fetch_date(date)
            except UpstreamError as exc:
                # Includes RetryableUpstreamError after its own retries: skip
                # this candidate and let the remaining tiers answer.
                last_error = exc
                log.warning(
                    "live-date: probe date=%s (%s) failed: %s -- skipping candidate",
                    date or "<server default>",
                    source,
                    exc,
                )
                continue
            probes += 1
            active = count_active_vehicles(raw)
            log.info(
                "live-date: date=%s via %s -> %d active vehicle(s) (threshold %d)",
                date or "<server default>",
                source,
                active,
                threshold,
            )
            if best is None or active > best[3]:
                best = (raw, date, source, active)
            if active >= threshold:
                resolution = DateResolution(
                    configured_date=configured,
                    resolved_date=date,
                    source=source,
                    active_vehicles=active,
                    probes=probes,
                    satisfied=True,
                    resolved_at=now,
                )
                log.info(
                    "live-date: resolved to %s via %s -- %d active vehicle(s) in %d probe(s)",
                    date or "<server default>",
                    source,
                    active,
                    probes,
                )
                return raw, resolution

            # Tier 2: the batch's own reporting dates, newest first.  Inserted
            # ahead of the walk-back tier because a date the fleet actually
            # reports is a stronger hint than calendar arithmetic.
            for report_date in report_dates(raw, settings.tz):
                if report_date not in tried:
                    queue.appendleft((report_date, "report-date"))
            # Tier 3: walk back from today (source-local), newest first.
            if not walkback_queued:
                walkback_queued = True
                today = datetime.now(settings.tz).date()
                for offset in range(settings.live_date_probe_days):
                    queue.append(((today - timedelta(days=offset)).isoformat(), "walkback"))

        if best is None:
            # Every candidate errored: surface the last transport failure so
            # the orchestrator's retry/backoff policy applies unchanged.
            raise last_error or UpstreamError("live-date resolution made no successful request")

        raw, date, source, active = best
        resolution = DateResolution(
            configured_date=configured,
            resolved_date=date,
            source=source,
            active_vehicles=active,
            probes=probes,
            satisfied=False,
            resolved_at=now,
        )
        log.warning(
            "live-date: no date reached %d active vehicle(s) in %d probe(s) -- "
            "ingesting the best batch seen (date=%s via %s, %d active) instead of an empty payload",
            threshold,
            probes,
            date or "<server default>",
            source,
            active,
        )
        return raw, resolution

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
