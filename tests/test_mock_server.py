"""The mock upstream must be as correct as the thing it stands in for.

These tests exist because the mock had a real bug: with `all_fields=False` it
raised KeyError while building `summary`, which surfaced to the engine as a bare
"connection closed" -- the exact kind of failure the retry logic is supposed to
absorb, and therefore the exact kind that hides.
"""

from __future__ import annotations

import threading

import pytest

from telemetry.config import Settings
from telemetry.extractor import TelemetryExtractor
from telemetry.api import UpstreamClient
from telemetry.auth import TokenManager
from tools.mock_server import DOCUMENTED_KEYS, Fleet, make_server


@pytest.fixture
def documented_only_api():
    """A mock serving ONLY the 11 keys DASHBOARD_API_GUIDE.md documents."""
    server = make_server(port=0, vehicles=3, all_fields=False)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    yield f"http://{host}:{port}", server.fleet  # type: ignore[attr-defined]
    server.shutdown()
    server.server_close()


# ------------------------------------------------------------------ unit level
def test_documented_only_payload_still_builds_a_summary():
    """The regression: summary used to read charging_status off emitted frames."""
    fleet = Fleet(3, all_fields=False)
    payload = fleet.payload(date=None, vehicle=None)

    assert payload["ok"] is True
    assert len(payload["vehicles"]) == 3
    assert set(next(iter(payload["vehicles"].values()))) == set(DOCUMENTED_KEYS)
    assert payload["summary"]["overall"]["vehicle_count"] == 3
    assert "charging" in payload["summary"]["overall"]


def test_all_fields_payload_emits_24_parameters_plus_timestamp():
    fleet = Fleet(3, all_fields=True)
    frame = next(iter(fleet.payload(date=None, vehicle=None)["vehicles"].values()))
    assert len(frame) == 25  # 24 parameters + last_updated


def test_every_emitted_key_is_mapped_by_the_engine():
    """If the mock emits a key the registry does not know, the mock has drifted."""
    from telemetry.fields import ALIAS_TO_NAME

    for all_fields in (False, True):
        fleet = Fleet(2, all_fields=all_fields)
        frame = next(iter(fleet.payload(date=None, vehicle=None)["vehicles"].values()))
        unknown = [k for k in frame if k.lower() not in ALIAS_TO_NAME and k != "last_updated"]
        assert unknown == [], f"mock emits keys the engine cannot map: {unknown}"


def test_consecutive_polls_advance_the_reported_clock():
    """Otherwise sub-second polls look like duplicate frames and dedupe away."""
    fleet = Fleet(2, all_fields=True)
    first = next(iter(fleet.payload(date=None, vehicle=None)["vehicles"].values()))["last_updated"]
    second = next(iter(fleet.payload(date=None, vehicle=None)["vehicles"].values()))["last_updated"]
    assert first != second


# ------------------------------------------------------- engine against it
def test_engine_runs_against_a_documented_only_upstream(documented_only_api, pg_session):
    # PostgreSQL only: the write path is a PostgreSQL upsert, and SQLite cannot
    # autoincrement a BIGSERIAL primary key.
    """The realistic first-day scenario: only 10 of the 24 parameters exist.

    The engine must ingest them, NULL the rest, and say so loudly -- not crash,
    and not silently pretend it has 24 parameters.
    """
    base_url, fleet = documented_only_api
    settings = Settings(
        api_base_url=base_url,
        api_secret_key="sk_mock_9f8e7d6c5b4a",
        api_passcode="MockPasscode123",
        database_url="sqlite://",
        _env_file=None,
    )
    client = UpstreamClient(settings)
    extractor = TelemetryExtractor(settings, client, TokenManager(settings, client))

    report = extractor.run_cycle(pg_session)

    assert report.seen == 3
    assert report.accepted == 3
    assert report.rejected == 0
    assert report.write.states_written == 3
    # 14 parameters are absent from the payload -> reported, not silently dropped
    assert report.missing_params == 3 * 14, report.missing_params
    assert extractor.drift.last is not None
    assert len(extractor.drift.last.missing) == 14
    assert len(extractor.drift.last.present) == 10

    from telemetry.models import VehicleState

    state = pg_session.get(VehicleState, sorted(fleet.state)[0])
    assert state is not None
    assert state.soc is not None          # documented -> populated
    assert state.work_status is None      # undocumented -> NULL
