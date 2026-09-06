"""One observable cycle, shared by the continuous worker and the HTTP/cron app.

The journal is in PostgreSQL, not process memory. A function killed mid-cycle
leaves a running entry; a failed write cannot be reported as upstream staleness.
No raw exception bodies, credentials or database URLs enter this journal.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings
from .document import source_observed_at
from .exceptions import AuthError, TelemetryError, UpstreamError
from .extractor import CycleReport, TelemetryExtractor
from .models import IngestionRun, VehicleState

log = logging.getLogger(__name__)


def utc(value: datetime) -> datetime:
    """SQLite returns naive DB timestamps; persisted timestamps are always UTC."""
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def iso(value: datetime | None) -> str | None:
    return utc(value).isoformat() if value else None


def failure_detail(exc: Exception) -> tuple[str, str]:
    """Allowlisted diagnostics: never echo upstream bodies or SQL parameters."""
    if isinstance(exc, AuthError):
        return "upstream_auth", "Upstream authentication failed. Check the rotated API credentials and client status."
    if isinstance(exc, UpstreamError):
        status = f" (HTTP {exc.status_code})" if exc.status_code else ""
        return "upstream_error", f"Upstream request failed{status}. Check upstream availability and the cycle logs."
    if isinstance(exc, SQLAlchemyError):
        return "database_error", "Database access failed. Check Neon connectivity and schema permissions."
    if isinstance(exc, (ValidationError, TelemetryError)):
        return "validation_error", "The upstream response could not be validated. Check the cycle logs."
    if isinstance(exc, RuntimeError):
        return "configuration_error", "Ingestion configuration is invalid. Check API_SECRET_KEY, API_PASSCODE, API_BASE_URL and DATABASE_URL."
    return "unexpected_error", "An unexpected ingestion error occurred. Check the cycle logs."


def _event(event: str, **fields: Any) -> None:
    # Text logs remain self-contained; JsonFormatter lifts the same fields
    # into top-level keys, rather than double-encoding a JSON message string.
    payload = {"event": event, "timestamp": iso(datetime.now(timezone.utc)), **fields}
    message = " ".join(f"{key}={value}" for key, value in payload.items())
    log.log(logging.ERROR if event == "ingest_failed" else logging.INFO, message, extra=payload)


def report_summary(report: CycleReport) -> dict[str, Any]:
    return {
        "seen": report.seen,
        "accepted": report.accepted,
        "rejected": report.rejected,
        "field_errors": report.field_errors,
        "states_written": report.write.states_written,
        "history_written": report.write.history_written,
        "unchanged_skipped": report.write.skipped_unchanged,
        "stale_skipped": report.write.states_skipped_stale,
        "detail_ok": report.detail_ok,
        "detail_failed": report.detail_failed,
        "resolved_date": report.resolved_date,
        "date_source": report.date_source,
        "date_probes": report.date_probes,
        "date_probe_errors": report.date_probe_errors,
        "date_satisfied": report.date_satisfied,
        "active_vehicles": report.active_vehicles,
        "newest_observed_at": iso(report.newest_observed_at),
        "missing_timestamps": report.missing_timestamps,
    }


def cycle_payload(run: IngestionRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "ok": run.status in {"success", "partial"},
        "status": run.status,
        "trigger": run.trigger,
        "started_at": iso(run.started_at),
        "finished_at": iso(run.finished_at),
        "cycle_seconds": round((utc(run.finished_at) - utc(run.started_at)).total_seconds(), 3) if run.finished_at else None,
        "summary": run.summary,
        "error_code": run.error_code,
        "detail": run.error_detail,
    }


@dataclass
class RecordedCycle:
    report: CycleReport
    payload: dict[str, Any]


def run_recorded_cycle(
    settings: Settings,
    factory: sessionmaker,
    extractor: TelemetryExtractor,
    *,
    trigger: str,
) -> RecordedCycle:
    """Persist start/outcome even on auth, validation or unexpected failures.

    The caller ensures the schema and owns scheduling/single-flight. Only the
    extractor writes vehicle data; this wrapper never invents observations.
    """
    run_id = str(uuid4())
    started_at = datetime.now(timezone.utc)
    started = time.monotonic()
    _event("ingest_started", cycle_id=run_id, trigger=trigger)
    session = None
    recorded = False
    try:
        session = factory()
        run = IngestionRun(id=run_id, trigger=trigger, started_at=started_at, status="running")
        session.add(run)
        session.execute(delete(IngestionRun).where(IngestionRun.started_at < started_at - timedelta(days=30)))
        session.commit()  # visible before any upstream I/O, even if the process is killed
        recorded = True

        settings.validate_required()
        report = extractor.run_cycle(session)
        summary = report_summary(report)
        partial = (
            report.rejected > 0
            or report.field_errors > 0
            or report.write.states_skipped_stale > 0
            or report.detail_failed > 0
            or report.date_probe_errors > 0
            or not report.date_satisfied
            or report.accepted == 0
            or report.missing_timestamps > 0
        )
        run.status = "partial" if partial else "success"
        run.finished_at = datetime.now(timezone.utc)
        run.summary = summary
        session.commit()
        payload = cycle_payload(run)
        _event("ingest_finished", cycle_id=run_id, trigger=trigger, status=run.status,
               duration_seconds=round(time.monotonic() - started, 3), **summary)
        return RecordedCycle(report, {**payload, "report_line": report.summary()})
    except Exception as exc:
        code, detail = failure_detail(exc)
        if session is not None:
            session.rollback()
            if recorded:
                try:
                    run = session.get(IngestionRun, run_id)
                    if run is not None:
                        run.status = "failed"
                        run.finished_at = datetime.now(timezone.utc)
                        run.error_code, run.error_detail = code, detail
                        session.commit()
                except SQLAlchemyError:
                    session.rollback()
                    # The start row (if written) remains running, never success.
                    log.error("could not persist failed outcome for cycle_id=%s (database unavailable)", run_id)
        _event("ingest_failed", cycle_id=run_id, trigger=trigger, error_code=code,
               error_type=type(exc).__name__, detail=detail,
               duration_seconds=round(time.monotonic() - started, 3))
        raise
    finally:
        if session is not None:
            session.close()


def ingestion_health(
    session: Session,
    settings: Settings,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Evidence-based status. A successful HTTP read is NOT a successful poll."""
    now = utc(now or datetime.now(timezone.utc))
    latest = session.scalar(select(IngestionRun).order_by(IngestionRun.started_at.desc()).limit(1))
    success = session.scalar(
        select(IngestionRun).where(IngestionRun.status == "success")
        .order_by(IngestionRun.started_at.desc()).limit(1)
    )
    # Only timestamp + validator verdict columns, not the full telemetry
    # payload. Exclude ingest-time fallback keys exactly as the document does.
    timestamp_rows = session.execute(select(VehicleState.last_updated, VehicleState.field_errors))
    newest = max((utc(stamp) for stamp, errors in timestamp_rows
                  if source_observed_at(stamp, errors) is not None), default=None)
    result: dict[str, Any] = {
        "state": "never",
        "detail": "No ingestion attempt is recorded. Start the polling worker or configure the cron scheduler.",
        "expected_interval_seconds": settings.poll_interval_seconds,
        "last_attempt": cycle_payload(latest) if latest else None,
        "last_success_at": iso(success.finished_at) if success else None,
        "newest_observed_at": iso(newest),
    }
    missing = [name for name, value in (
        ("API_SECRET_KEY", settings.api_secret_key), ("API_PASSCODE", settings.api_passcode),
    ) if not value]
    if (os.getenv("VERCEL") or os.getenv("AWS_LAMBDA_FUNCTION_NAME")) and not settings.cron_secret:
        missing.append("CRON_SECRET")
    if missing:
        return {**result, "state": "configuration_error", "detail": f"Ingestion is not configured: set {', '.join(missing)}."}
    if latest is None:
        return result

    age = (now - utc(latest.started_at)).total_seconds()
    if latest.status == "running":
        stalled = age > settings.ingest_running_timeout_seconds
        return {**result, "state": "overdue" if stalled else "running",
                "detail": "The last ingestion attempt did not finish within its expected runtime. Check worker/function logs for a timeout."
                if stalled else "An ingestion cycle is in progress. Showing the last committed observations."}
    if latest.status == "failed":
        return {**result, "state": "failed", "detail": latest.error_detail or "The last ingestion attempt failed. Check the cycle logs."}
    # One interval + a small scheduling/HTTP grace, not a many-hour freshness threshold.
    if age > settings.poll_interval_seconds + 30:
        return {**result, "state": "overdue",
                "detail": "No recent ingestion cycle. Check that the worker or five-minute cron is running; upstream freshness is unknown."}
    if latest.status == "partial":
        summary = latest.summary or {}
        return {**result, "state": "partial", "detail": (
            f"Last poll was incomplete: {summary.get('accepted', 0)} accepted, "
            f"{summary.get('rejected', 0)} rejected, {summary.get('field_errors', 0)} field errors, "
            f"{summary.get('detail_failed', 0)} detail failures, "
            f"{summary.get('date_probe_errors', 0)} date probe errors, "
            f"{summary.get('missing_timestamps', 0)} missing source timestamps, "
            f"{summary.get('stale_skipped', 0)} snapshot updates blocked by anti-regression guards. "
            + ("The fleet threshold was not met; a best-effort batch was retained. " if not summary.get("date_satisfied") else "")
            + "Newer upstream data cannot be ruled out."
        )}
    if settings.api_date or not settings.live_date_fallback:
        return {**result, "state": "date_limited",
                "detail": "Ingestion succeeded, but API_DATE or disabled date fallback limits the search. Clear API_DATE and enable fallback for live monitoring."}
    if newest is None:
        return {**result, "state": "partial", "detail": "The last poll completed but no usable observation timestamp is available."}
    if (now - utc(newest)).total_seconds() > settings.poll_interval_seconds + 30:
        return {**result, "state": "upstream_stale", "detail": (
            "The last poll succeeded, but upstream returned older observations. "
            "No fresher fleet was found within the configured date-probe budget; this is not proof that every upstream date was checked."
        )}
    return {**result, "state": "healthy", "detail": "The last ingestion cycle succeeded and the newest observation is within the polling window."}
