"""End-to-end: the loop against a live mock upstream and a live PostgreSQL.

These are the tests that would catch the failures which actually page people:
data silently stops, the engine dies on the first 500, or a token expiry loses a
poll.  They exercise the real orchestrator, real HTTP and real SQL.
"""

from __future__ import annotations

import time

import pytest
from sqlalchemy import func, select

from telemetry.api import UpstreamClient
from telemetry.auth import TokenManager
from telemetry.config import Settings
from telemetry.extractor import TelemetryExtractor
from telemetry.metrics import Metrics
from telemetry.models import Telemetry, Vehicle, VehicleState
from telemetry.orchestrator import TelemetryOrchestrator

def make_orchestrator(mock_api, pg_engine, **overrides) -> TelemetryOrchestrator:
    options: dict = {
        "api_base_url": mock_api.base_url,
        "api_secret_key": mock_api.secret_key,
        "api_passcode": mock_api.passcode,
        "database_url": str(pg_engine.url),
        "poll_interval_seconds": 0.02,
        "backoff_base_seconds": 0.001,
        "backoff_max_seconds": 0.004,
        "http_max_retries": 3,
        "error_backoff_seconds": 0.01,
        "auth_backoff_seconds": 0.01,
        # The harness fleet is 4 trucks; the production live-date threshold is
        # 5.  Keep the resolver out of these loops (it is exercised in
        # tests/test_live_date.py) so every cycle sends exactly one tier-1
        # GET, as it did before date resolution existed.
        "live_date_min_vehicles": 1,
    }
    options.update(overrides)  # caller wins
    settings = Settings(_env_file=None, **options)
    from sqlalchemy.orm import sessionmaker

    factory = sessionmaker(bind=pg_engine, expire_on_commit=False, future=True)
    client = UpstreamClient(settings)
    tokens = TokenManager(settings, client)
    metrics = Metrics()
    extractor = TelemetryExtractor(settings, client, tokens, metrics=metrics)
    orchestrator = TelemetryOrchestrator(
        settings, factory, extractor=extractor, tokens=tokens, client=client, metrics=metrics
    )
    return orchestrator


@pytest.fixture
def pg_engine(pg_url):
    """A real PostgreSQL engine, truncated first so counts are absolute.

    Skips (rather than erroring) when TEST_DATABASE_URL is unset, so a plain
    `pytest` run still gives a green suite on a machine with no PostgreSQL.
    """
    if not pg_url:
        pytest.skip("TEST_DATABASE_URL not set -- PostgreSQL-backed tests skipped")

    from sqlalchemy import create_engine, text

    engine = create_engine(pg_url, future=True)
    from telemetry.models import Base

    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE telemetry, vehicle_state, vehicles RESTART IDENTITY CASCADE"))
    yield engine
    engine.dispose()


# ---------------------------------------------------------------- happy path
def test_full_cycle_writes_the_whole_fleet(mock_api, pg_engine):
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine)

    assert orch.run_once() is True

    with pg_engine.connect() as conn:
        assert conn.scalar(select(func.count()).select_from(Vehicle)) == 4
        assert conn.scalar(select(func.count()).select_from(VehicleState)) == 4
        assert conn.scalar(select(func.count()).select_from(Telemetry)) == 4

    assert orch.cycles == 1 and orch.failures == 0
    assert orch.tokens.auth_count == 1  # tier-2 detail fetches reuse the summary token


def test_full_cycle_writes_live_battery_telemetry(mock_api, pg_engine):
    """The point of the two-tier fetch: `batt_v` / `chg_status` / `work_sts`
    from the tier-2 detail feed land in the state table as populated columns,
    not NULLs."""
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine)
    assert orch.run_once() is True

    with pg_engine.connect() as conn:
        states = conn.execute(
            select(VehicleState.vehicle_id, VehicleState.battery_total_v, VehicleState.charging_status, VehicleState.work_status)
        ).all()
    assert len(states) == 4
    for vehicle_id, batt_v, chg, work in states:
        assert batt_v is not None, f"{vehicle_id}: battery_total_v NULL after a two-tier cycle"
        assert chg is not None, f"{vehicle_id}: charging_status NULL after a two-tier cycle"
        assert work is not None, f"{vehicle_id}: work_status NULL after a two-tier cycle"


def test_repeated_cycles_accumulate_history(mock_api, pg_engine):
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine)

    for _ in range(4):
        assert orch.run_once() is True

    with pg_engine.connect() as conn:
        # 4 polls, and the mock advances `last_updated` each time -> 4 rows/vehicle
        assert conn.scalar(select(func.count()).select_from(Telemetry)) == 16
        # ...but the snapshot stays 1:1 with the fleet
        assert conn.scalar(select(func.count()).select_from(VehicleState)) == 4
        assert conn.scalar(select(Vehicle.ingest_count).limit(1)) == 4


# --------------------------------------------------------------- 401 recovery
def test_revoked_token_recovers_without_losing_the_cycle(mock_api, pg_engine):
    """Simulates the admin 'toggle' endpoint and mid-run expiry: the poll that
    hits the 401 must still land, on a freshly minted token."""
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine)
    assert orch.run_once() is True
    first_auths = orch.tokens.auth_count
    rows_before = _history_count(pg_engine)

    mock_api.control("/__control/revoke")  # every outstanding token is now dead
    assert orch.run_once() is True

    assert orch.tokens.auth_count == first_auths + 1, "expected exactly one re-authentication"
    assert orch.tokens.forced_refresh_count == 1
    assert orch.failures == 0, "the 401 must be absorbed, not counted as a failed cycle"
    assert _history_count(pg_engine) == rows_before + 4, "the retried poll must still be written"
    assert mock_api.stats()["counts"]["data_401"] == 1


def test_expired_token_rotation_happens_proactively(mock_api, pg_engine):
    """With a 2-second rotation interval the engine must re-auth between polls,
    exactly as it will at 55 minutes in production."""
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine, token_refresh_interval=2.0)

    assert orch.run_once() is True
    first_token = orch.tokens.get_token()
    time.sleep(2.1)
    assert orch.run_once() is True

    assert orch.tokens.auth_count == 2
    assert orch.tokens.get_token() != first_token
    assert mock_api.stats()["counts"]["auth"] == 2
    assert mock_api.stats()["counts"]["data_401"] == 0, "proactive rotation means we never see a 401"


# -------------------------------------------------------------- 5xx recovery
def test_upstream_500s_are_absorbed_and_the_cycle_still_lands(mock_api, pg_engine):
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine)
    mock_api.control("/__control/fail?count=2")  # two 500s, then healthy

    assert orch.run_once() is True
    assert orch.failures == 0
    assert mock_api.stats()["counts"]["data_500"] == 2
    assert _history_count(pg_engine) == 4


def test_persistent_500s_fail_the_cycle_but_not_the_process(mock_api, pg_engine):
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine)
    mock_api.control("/__control/fail?count=99")

    assert orch.run_once() is False
    assert orch.failures == 1
    # and the very next cycle recovers on its own
    mock_api.control("/__control/fail?count=0")
    assert orch.run_once() is True
    assert orch.cycles == 1


# ----------------------------------------------------------------- bad creds
def test_bad_credentials_are_reported_not_retried_forever(mock_api, pg_engine):
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine, api_passcode="definitely-wrong")
    assert orch.run_once() is False
    assert mock_api.stats()["counts"]["auth_failed"] >= 1
    assert orch.cycles == 0


def test_identical_consecutive_frames_are_not_re_archived(mock_api, pg_engine):
    """An idle truck reporting the same frame twice must not multiply history.

    Two independent guarantees are checked:
      * the extractor's signature check skips the write entirely, and
      * even if it did not, UNIQUE (vehicle_id, observed_at) would dedupe it.
    The mock is *frozen* (clock and state both held still) so the two frames are
    genuinely byte-identical -- decrementing the tick counter alone is not
    enough, because the random-walk state keeps moving and the frames differ.
    """
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine)

    assert orch.run_once() is True
    assert _history_count(pg_engine) == 4
    assert orch.extractor._last_signature, "the extractor should be tracking frame signatures"

    mock_api.control("/__control/freeze?on=1")
    report = orch.run_once_and_report()
    assert report.write.skipped_unchanged == 4, "identical frames should be skipped"
    assert report.write.history_written == 0
    assert _history_count(pg_engine) == 4, "no duplicate history rows"

    # ...and the snapshot still reflects that we saw every vehicle
    with pg_engine.connect() as conn:
        assert conn.scalar(select(func.count()).select_from(VehicleState)) == 4


def test_dedupe_holds_even_when_the_skip_optimisation_is_disabled(mock_api, pg_engine):
    """With WRITE_UNCHANGED=true the engine writes every poll; the UNIQUE
    constraint alone must still prevent duplicate history rows."""
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine, write_unchanged=True)

    assert orch.run_once() is True
    assert _history_count(pg_engine) == 4

    mock_api.control("/__control/freeze?on=1")
    report = orch.run_once_and_report()
    assert report.write.skipped_unchanged == 0, "the optimisation is off"
    assert _history_count(pg_engine) == 4, "the unique constraint must still dedupe"


# ---------------------------------------------------------------- run_forever
def test_run_forever_stops_cleanly_on_request(mock_api, pg_engine):
    """SIGTERM handling: the loop exits on request instead of being killed."""
    import threading

    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine, poll_interval_seconds=0.05)

    stopper = threading.Timer(0.4, orch.request_stop)
    stopper.start()
    exit_code = orch.run_forever()
    stopper.cancel()

    assert exit_code == 0
    assert orch.cycles >= 2, f"expected several cycles in 400 ms, got {orch.cycles}"
    assert orch.failures == 0


def test_metrics_record_the_last_successful_cycle(mock_api, pg_engine):
    mock_api.reset()
    orch = make_orchestrator(mock_api, pg_engine)
    orch.run_once()

    rendered = orch.metrics.render()
    assert "twin_cycles_total 1" in rendered
    assert "twin_vehicles_seen 4" in rendered
    assert "twin_last_successful_cycle_timestamp_seconds" in rendered
    assert "twin_token_seconds_until_refresh" in rendered
    # The token itself must never leak into a metrics scrape.
    assert orch.tokens.get_token() not in rendered


def test_metrics_endpoint_serves_prometheus_text(mock_api, pg_engine):
    import requests

    from telemetry.metrics import start_metrics_server

    orch = make_orchestrator(mock_api, pg_engine, metrics_enabled=True)
    server = start_metrics_server(orch.metrics, 0)  # port 0 -> OS picks a free one
    port = server.server_address[1]
    try:
        orch.run_once()
        body = requests.get(f"http://127.0.0.1:{port}/metrics", timeout=5).text
        assert "twin_cycles_total 1" in body
    finally:
        server.shutdown()
        server.server_close()


# ------------------------------------------------------------------- helpers
def _history_count(engine) -> int:
    with engine.connect() as conn:
        return conn.scalar(select(func.count()).select_from(Telemetry))
