"""Durable staleness evidence: successful old observations != broken ingestion."""
from datetime import datetime, timedelta, timezone
import json
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from telemetry.config import Settings
from telemetry.exceptions import AuthRejectedError, RetryableUpstreamError
from telemetry.extractor import CycleReport
from telemetry.ingestion import ingestion_health, run_recorded_cycle
from telemetry.models import Base, IngestionRun
from telemetry.logging_setup import JsonFormatter
from telemetry.repository import TelemetryRepository, WriteResult
from telemetry.schemas import ParsedVehicle


@pytest.fixture
def store(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'journal.db'}")
    Base.metadata.create_all(engine)
    yield sessionmaker(engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def config():
    return Settings(_env_file=None, database_url="sqlite://", api_base_url="http://unused.invalid",
                    api_secret_key="sk_test", api_passcode="test_only", poll_interval_seconds=300)


class Extractor:
    def __init__(self, observed=None, **report_fields):
        self.observed = observed or datetime.now(timezone.utc)
        self.report_fields = report_fields

    def run_cycle(self, session):
        now = datetime.now(timezone.utc)
        report = CycleReport(started_at=now, ingested_at=now, seen=1, accepted=1,
                             date_source="server-default", date_satisfied=True, active_vehicles=1,
                             newest_observed_at=self.observed)
        report.write = TelemetryRepository(session).write_cycle([
            ParsedVehicle(vehicle_id="TRUCK01", observed_at=self.observed, values={"soc": 65}),
        ], ingested_at=now)
        session.commit()
        for key, value in self.report_fields.items():
            setattr(report, key, value)
        return report


def health(store, config, **kwargs):
    # A NEW session, with no reference to any HTTP/worker in-memory state.
    with store() as session:
        return ingestion_health(session, config, **kwargs)


def test_recent_success_is_persisted_and_survives_a_new_reader(store, config, caplog):
    caplog.set_level("INFO", logger="telemetry.ingestion")
    result = run_recorded_cycle(config, store, Extractor(), trigger="worker")
    diagnostic = health(store, config)
    assert diagnostic["state"] == "healthy"
    assert diagnostic["last_attempt"]["id"] == result.payload["id"]
    assert diagnostic["last_success_at"].endswith("+00:00")
    assert diagnostic["last_attempt"]["summary"]["accepted"] == 1
    events = [json.loads(JsonFormatter().format(r)) for r in caplog.records if r.name == "telemetry.ingestion"]
    assert [e["event"] for e in events] == ["ingest_started", "ingest_finished"]
    assert all(e["timestamp"] and e["cycle_id"] for e in events)
    assert events[-1]["accepted"] == 1
    assert events[-1]["date_probe_errors"] == 0


def test_recent_success_with_72_hour_old_data_is_upstream_stale(store, config):
    old = datetime.now(timezone.utc) - timedelta(hours=72)
    run_recorded_cycle(config, store, Extractor(observed=old), trigger="cron")
    diagnostic = health(store, config)
    assert diagnostic["state"] == "upstream_stale"
    assert "budget" in diagnostic["detail"]
    assert diagnostic["newest_observed_at"] == old.isoformat()


def test_unchanged_upstream_frames_do_not_make_ingestion_look_dead(store, config):
    old = datetime.now(timezone.utc) - timedelta(hours=72)
    first = run_recorded_cycle(config, store, Extractor(observed=old), trigger="cron")
    second = run_recorded_cycle(config, store, Extractor(observed=old), trigger="cron")
    assert health(store, config)["last_attempt"]["id"] == second.payload["id"]
    assert first.payload["id"] != second.payload["id"]
    assert health(store, config)["state"] == "upstream_stale"


@pytest.mark.parametrize("exc,code", [
    (AuthRejectedError("secret-do-not-log"), "upstream_auth"),
    (RetryableUpstreamError("secret-do-not-log", status_code=500), "upstream_error"),
    (OperationalError("secret-do-not-log", {}, Exception("secret-do-not-log")), "database_error"),
    (ValueError("secret-do-not-log"), "unexpected_error"),
])
def test_failures_are_durable_sanitized_and_not_mistaken_for_upstream_staleness(store, config, caplog, exc, code):
    run_recorded_cycle(config, store, Extractor(), trigger="worker")
    last_success = health(store, config)["last_success_at"]

    class Failing:
        def run_cycle(self, session):
            raise exc

    with pytest.raises(type(exc)):
        run_recorded_cycle(config, store, Failing(), trigger="cron")
    diagnostic = health(store, config)
    assert diagnostic["state"] == "failed"
    assert diagnostic["last_attempt"]["error_code"] == code
    assert diagnostic["last_success_at"] == last_success
    assert "secret-do-not-log" not in json.dumps(diagnostic) + caplog.text
    assert "event=ingest_failed" in caplog.text


@pytest.mark.parametrize("fields", [
    {"date_satisfied": False}, {"detail_failed": 1}, {"date_probe_errors": 1},
    {"rejected": 1}, {"accepted": 0}, {"missing_timestamps": 1}, {"field_errors": 1},
    {"write": WriteResult(states_skipped_stale=1)},
])
def test_partial_cycles_never_claim_that_upstream_has_nothing_newer(store, config, fields):
    run_recorded_cycle(config, store, Extractor(**fields), trigger="cron")
    diagnostic = health(store, config)
    assert diagnostic["state"] == "partial"
    assert "cannot be ruled out" in diagnostic["detail"]


def test_an_overdue_poller_is_not_hidden_by_recent_database_observations(store, config):
    result = run_recorded_cycle(config, store, Extractor(), trigger="worker")
    with store.begin() as session:
        run = session.get(IngestionRun, result.payload["id"])
        run.started_at -= timedelta(minutes=10)
        run.finished_at -= timedelta(minutes=10)
    assert health(store, config)["state"] == "overdue"


def test_first_boot_never_guesses_why_an_old_snapshot_is_stale(store, config):
    assert health(store, config)["state"] == "never"


def test_interrupted_cycle_is_running_then_stalled_not_success(store, config):
    start = datetime.now(timezone.utc)
    with store.begin() as session:
        session.add(IngestionRun(id=str(uuid4()), trigger="cron", status="running", started_at=start))
    assert health(store, config, now=start + timedelta(seconds=10))["state"] == "running"
    assert health(store, config, now=start + timedelta(seconds=61))["state"] == "overdue"
    assert health(store, config)["last_success_at"] is None


def test_missing_credentials_are_a_configuration_error(store, config):
    config.api_passcode = ""
    with pytest.raises(RuntimeError):
        run_recorded_cycle(config, store, Extractor(), trigger="worker")
    diagnostic = health(store, config)
    assert diagnostic["state"] == "configuration_error"
    assert diagnostic["last_attempt"]["status"] == "failed"
    assert "API_PASSCODE" in diagnostic["detail"]


def test_missing_vercel_secret_is_visible_even_after_previous_success(store, config, monkeypatch):
    run_recorded_cycle(config, store, Extractor(), trigger="cron")
    monkeypatch.setenv("VERCEL", "1")
    assert health(store, config)["state"] == "configuration_error"
    assert "CRON_SECRET" in health(store, config)["detail"]


def test_pinned_date_is_not_presented_as_a_freshness_guarantee(store, config):
    config.api_date = "2026-08-28"
    run_recorded_cycle(config, store, Extractor(), trigger="cli")
    assert health(store, config)["state"] == "date_limited"


def test_journal_retention_is_bounded(store, config):
    with store.begin() as session:
        session.add(IngestionRun(id="old", trigger="cron", status="failed",
                                 started_at=datetime.now(timezone.utc) - timedelta(days=31)))
    run_recorded_cycle(config, store, Extractor(), trigger="worker")
    with store() as session:
        assert len(session.scalars(select(IngestionRun)).all()) == 1
