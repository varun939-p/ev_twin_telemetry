"""The mock upstream must be as correct as the thing it stands in for.

These tests exist because the mock had a real bug: with `all_fields=False` it
raised KeyError while building `summary`, which surfaced to the engine as a bare
"connection closed" -- the exact kind of failure the retry logic is supposed to
absorb, and therefore the exact kind that hides.
"""

from __future__ import annotations

import threading

import pytest

from datetime import datetime, timezone

from telemetry.config import Settings
from telemetry.extractor import TelemetryExtractor
from telemetry.api import UpstreamClient
from telemetry.auth import TokenManager
from telemetry.fields import ALIAS_TO_NAME
from telemetry.schemas import VehiclesPayload, flatten_vehicle_frame
from tools.mock_server import DOCUMENTED_KEYS, SUMMARY_KEYS, Fleet, make_server


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
def test_summary_payload_is_high_level_only():
    """Tier 1: frames carry the operational keys and `"battery": null` -- the
    regression guard for the two-tier v1 contract."""
    fleet = Fleet(3, all_fields=False)
    payload = fleet.payload(date=None, vehicle=None)

    assert payload["ok"] is True
    assert len(payload["vehicles"]) == 3
    frame = next(iter(payload["vehicles"].values()))
    assert set(frame) == set(SUMMARY_KEYS)
    assert frame["battery"] is None
    assert payload["summary"]["overall"]["vehicle_count"] == 3
    assert "charging" in payload["summary"]["overall"]


def test_detail_payload_emits_24_parameters_plus_timestamp():
    """Tier 2: the live diagnostic frame, battery block nested, v1 keys."""
    fleet = Fleet(3, all_fields=True)
    fleet.payload(date=None, vehicle=None)  # tick the clock first
    vid = next(iter(fleet.state))
    detail = fleet.vehicle_detail(vid)

    assert detail is not None
    flat = flatten_vehicle_frame(detail)
    assert len(flat) == 25  # 24 parameters + last_updated
    assert isinstance(detail["battery"], dict)
    # the confirmed v1 keys are all present inside the battery block
    assert {"batt_v", "batt_a", "chg_status", "tot_power_kwh", "work_sts"} <= set(detail["battery"])


def test_detail_unknown_vehicle_is_none():
    fleet = Fleet(3, all_fields=True)
    assert fleet.vehicle_detail("NOPE123") is None


def test_every_emitted_key_is_mapped_by_the_engine():
    """If the mock emits a key the registry does not know, the mock has drifted."""
    for all_fields in (False, True):
        fleet = Fleet(2, all_fields=all_fields)
        fleet.payload(date=None, vehicle=None)
        summary_frame = next(iter(fleet.payload(date=None, vehicle=None)["vehicles"].values()))
        detail_frame = next(iter(fleet.state))
        keys = list(summary_frame) + list(fleet.vehicle_detail(detail_frame) or {})
        keys += list((fleet.vehicle_detail(detail_frame) or {}).get("battery") or {})
        unknown = [k for k in keys if k.lower() not in ALIAS_TO_NAME and k not in ("last_updated", "battery")]
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
    """The restricted-field scenario: summary + a detail feed that only emits
    the 11 documented keys.

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
        # tiny harness fleet: keep the live-date resolver out of these
        # unit-level paths (covered in tests/test_live_date.py)
        live_date_min_vehicles=1,
    )
    client = UpstreamClient(settings)
    extractor = TelemetryExtractor(settings, client, TokenManager(settings, client))

    report = extractor.run_cycle(pg_session)

    assert report.seen == 3
    assert report.accepted == 3
    assert report.rejected == 0
    assert report.write.states_written == 3
    assert report.detail_ok == 3 and report.detail_failed == 0
    # 12 parameters are absent from summary+detail -> reported, not silently dropped
    assert report.missing_params == 3 * 12, report.missing_params
    assert extractor.drift.last is not None
    assert len(extractor.drift.last.missing) == 12
    assert len(extractor.drift.last.present) == 12

    from telemetry.models import VehicleState

    state = pg_session.get(VehicleState, sorted(fleet.state)[0])
    assert state is not None
    assert state.soc is not None          # documented -> populated
    assert state.battery_total_v is None  # not in the restricted detail feed -> NULL
    assert state.work_status is None      # not in the restricted detail feed -> NULL


# ------------------------------------------------------- two-tier engine level
def test_two_tier_pipeline_populates_battery_telemetry():
    """The live-contract path, end to end without a database:

    tier-1 summary (`battery: null`) -> concurrent tier-2 detail fetch ->
    `batt_v`/`chg_status`/`batt_temp` remapped onto canonical columns ->
    validated values are populated, never NULL, never 0-by-default.
    """
    server = make_server(port=0, vehicles=2, all_fields=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    base_url = f"http://{host}:{port}"
    try:
        settings = Settings(
            api_base_url=base_url,
            api_secret_key="sk_mock_9f8e7d6c5b4a",
            api_passcode="MockPasscode123",
            database_url="sqlite://",
            _env_file=None,
            # tiny harness fleet: keep the live-date resolver out of these
            # unit-level paths (covered in tests/test_live_date.py)
            live_date_min_vehicles=1,
        )
        client = UpstreamClient(settings)
        extractor = TelemetryExtractor(settings, client, TokenManager(settings, client))

        payload = extractor._validate_envelope(extractor._fetch())
        vid, summary_frame = next(iter(payload.vehicles.items()))
        assert summary_frame["battery"] is None  # tier 1 is summary-only

        payload, ok, failed = extractor._enrich_with_details(payload)
        assert (ok, failed) == (2, 0)

        detail = server.fleet.vehicle_detail(vid)
        expected_v = detail["battery"]["batt_v"]
        expected_chg = detail["battery"]["chg_status"]
        expected_temp = detail["batt_temp"]

        validated = extractor._validate_vehicles(payload, datetime.now(timezone.utc))
        assert validated.accepted == 2 and not validated.rejected
        vehicle = next(v for v in validated.ok if v.vehicle_id == vid)

        values = vehicle.values
        assert values["battery_total_v"] == expected_v
        assert values["charging_status"] == expected_chg
        assert values["battery_temp_c"] == expected_temp
        assert values["work_status"] == detail["battery"]["work_sts"]
        assert values["battery_current_a"] == detail["battery"]["batt_a"]
        # the populated channels are measured, not missing
        assert not {"battery_total_v", "charging_status", "battery_temp_c", "work_status"} & set(vehicle.missing)
    finally:
        server.shutdown()
        server.server_close()


def test_detail_fetch_failure_keeps_the_summary_frame():
    """One truck's tier-2 failure must degrade that truck to summary-only
    (battery channels NULL) instead of sinking the cycle."""
    server = make_server(port=0, vehicles=3, all_fields=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    base_url = f"http://{host}:{port}"
    try:
        settings = Settings(
            api_base_url=base_url,
            api_secret_key="sk_mock_9f8e7d6c5b4a",
            api_passcode="MockPasscode123",
            database_url="sqlite://",
            _env_file=None,
            # tiny harness fleet: keep the live-date resolver out of these
            # unit-level paths (covered in tests/test_live_date.py)
            live_date_min_vehicles=1,
        )
        client = UpstreamClient(settings)
        extractor = TelemetryExtractor(settings, client, TokenManager(settings, client))

        payload = extractor._validate_envelope(extractor._fetch())
        victim = sorted(payload.vehicles)[0]
        # Point tier 2 at a vehicle id the mock does not know -> 404, non-retryable.
        payload.vehicles["GHOST999"] = dict(payload.vehicles[victim])

        payload, ok, failed = extractor._enrich_with_details(payload)
        assert (ok, failed) == (3, 1)

        validated = extractor._validate_vehicles(payload, datetime.now(timezone.utc))
        assert validated.accepted == 4  # the ghost frame still validates (summary-level)
        ghost = next(v for v in validated.ok if v.vehicle_id == "GHOST999")
        assert ghost.values["battery_total_v"] is None  # no detail -> honest NULL
        assert ghost.values["soc"] is not None          # summary keys survived
    finally:
        server.shutdown()
        server.server_close()
