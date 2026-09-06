"""Live ingestion: list-wire tolerance, batch quality, and date resolution.

The upstream's `date` filter is the single biggest source of silent data loss:
an unset or stale `API_DATE` can answer with an empty fleet or a couple of
dead roster entries while a live batch sits one query parameter away.  These
tests pin the three layers of the fix:

  * wire normalizers (`vehicles_list_to_dict` / `extract_vehicle_id`) so a
    list-shaped `vehicles` validates through the same single gate;
  * batch-quality helpers (`is_frame_active`, `count_active_vehicles`,
    `report_dates`) that let the engine tell a live fleet from a dead roster;
  * the resolver in `TelemetryExtractor`, which probes for the freshest batch
    that actually holds active vehicles -- and never returns an empty payload
    when it saw anything at all.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from telemetry.api import USE_SETTINGS_DATE, UpstreamClient
from telemetry.auth import TokenManager
from telemetry.config import Settings
from telemetry.exceptions import RetryableUpstreamError, UpstreamClientError
from telemetry.extractor import TelemetryExtractor
from telemetry.schemas import (
    VehiclesPayload,
    count_active_vehicles,
    extract_vehicle_id,
    is_frame_active,
    merge_vehicle_frames,
    parse_payload,
    report_dates,
    vehicles_list_to_dict,
)

IST = ZoneInfo("Asia/Kolkata")


# ------------------------------------------------------------------- helpers
def active_frame(index: int, ts: str = "2026-09-01 10:00:00") -> dict:
    return {
        "last_updated": ts,
        "soc": 50 + index,
        "odo": 10_000 + index,
        "speed": 12 + index,
        "latitude": 18.5 + index * 0.01,
        "longitude": 73.8 + index * 0.01,
        "battery": None,
    }


def dead_frame(ts: str = "2026-09-01 10:00:00") -> dict:
    """A roster entry with a timestamp and the tier-1 placeholder only."""
    return {"last_updated": ts, "battery": None}


def batch(*frames: dict) -> dict:
    return {
        "ok": True,
        "summary": {"overall": {"vehicle_count": len(frames)}},
        "vehicles": {f"TRUCK{index:02d}": frame for index, frame in enumerate(frames)},
    }


def active_batch(count: int, ts: str = "2026-09-01 10:00:00") -> dict:
    return batch(*(active_frame(i, ts) for i in range(count)))


def dead_batch(count: int, ts: str = "2026-09-01 10:00:00") -> dict:
    return batch(*(dead_frame(ts) for _ in range(count)))


class FakeClient:
    """Stands in for UpstreamClient: routes tier-1 GETs by their `date`."""

    def __init__(self, batches: dict, *, errors: dict | None = None, error_all: bool = False) -> None:
        self.batches = dict(batches)
        self.errors = dict(errors or {})
        self.error_all = error_all
        self.calls: list = []

    def request_token(self) -> dict:
        return {"ok": True, "token": "tokentoken1234567890", "token_type": "Bearer", "expires_in": 3540}

    def fetch_vehicles(self, token: str, date=USE_SETTINGS_DATE) -> dict:
        assert date is not USE_SETTINGS_DATE, "the resolver must pin every probe explicitly"
        self.calls.append(date)
        if self.error_all or date in self.errors:
            raise self.errors.get(date, RetryableUpstreamError(f"date={date}: upstream 500 (exhausted)"))
        return self.batches.get(date, {"ok": True, "vehicles": {}})

    def fetch_vehicle(self, token: str, vehicle_id: str) -> dict:
        return {}


def make_settings(**overrides) -> Settings:
    options = {
        "api_base_url": "http://fake.invalid",
        "api_secret_key": "sk_test",
        "api_passcode": "pc_test",
        "database_url": "sqlite://",
        "_env_file": None,
        "backoff_base_seconds": 0.001,
        "backoff_max_seconds": 0.002,
        "http_max_retries": 1,
    }
    options.update(overrides)
    return Settings(**options)


def make_extractor(settings: Settings, client: FakeClient) -> TelemetryExtractor:
    return TelemetryExtractor(settings, client, TokenManager(settings, client))  # type: ignore[arg-type]


def today_ist() -> str:
    return datetime.now(IST).date().isoformat()


def days_ago_ist(n: int) -> str:
    return (datetime.now(IST).date() - timedelta(days=n)).isoformat()


# ------------------------------------------------------- wire normalizers
def test_extract_vehicle_id_handles_spelling_variants():
    assert extract_vehicle_id({"vehicle_id": " ap39wg5383 "}) == "ap39wg5383"
    assert extract_vehicle_id({"vehicleId": "AP39WG5383"}) == "AP39WG5383"
    assert extract_vehicle_id({"VEHICLE-ID": "AP39WG5383"}) == "AP39WG5383"
    assert extract_vehicle_id({"id": 5123}) == "5123"
    assert extract_vehicle_id({"plate": "MH12AB3434"}) == "MH12AB3434"
    assert extract_vehicle_id({"soc": 40}) is None
    assert extract_vehicle_id({"vehicle_id": "   "}) is None
    assert extract_vehicle_id("not a frame") is None


def test_vehicles_list_to_dict_rekeys_lists_and_passes_dicts():
    frames = [{"vehicle_id": "AP39WG5383", "soc": 70}, {"vehicleId": "AP39WH5376", "soc": 60}]
    keyed = vehicles_list_to_dict(frames)
    assert set(keyed) == {"AP39WG5383", "AP39WH5376"}
    assert keyed["AP39WG5383"]["soc"] == 70

    original = {"AP39WG5383": {"soc": 70}}
    assert vehicles_list_to_dict(original) is original
    assert vehicles_list_to_dict(None) is None


def test_vehicles_list_to_dict_drops_unnamed_and_duplicate_frames():
    keyed = vehicles_list_to_dict([{"soc": 70}, {"vehicle_id": "A1"}, {"vehicle_id": "A1"}])
    assert set(keyed) == {"A1"}


def test_vehicles_payload_accepts_the_list_wire_shape():
    payload = VehiclesPayload.model_validate(
        {"ok": True, "vehicles": [{"vehicle_id": "ap39wg5383", "soc": 70, "speed": 0}]}
    )
    assert set(payload.vehicles) == {"ap39wg5383"}
    result = parse_payload(payload, IST, ingest_time=datetime.now())
    assert result.accepted == 1
    assert result.ok[0].vehicle_id == "AP39WG5383"  # id normalisation still applies
    assert result.ok[0].values["soc"] == 70


# ------------------------------------------------------------ batch quality
def test_is_frame_active_separates_live_readings_from_dead_rosters():
    assert is_frame_active(active_frame(0)) is True
    assert is_frame_active(dead_frame()) is False
    assert is_frame_active({"last_updated": "2026-09-01 10:00:00", "speed": 0}) is True  # 0 is a reading
    assert is_frame_active({"vehicle_id": "X1", "last_updated": None, "battery": None}) is False
    assert is_frame_active("junk") is False
    assert is_frame_active({}) is False


def test_count_active_vehicles_reads_both_wire_shapes():
    assert count_active_vehicles(active_batch(6)) == 6
    assert count_active_vehicles(dead_batch(2)) == 0
    mixed = batch(active_frame(0), dead_frame())
    assert count_active_vehicles(mixed) == 1
    listed = {"ok": True, "vehicles": [active_frame(0), active_frame(1), dead_frame()]}
    listed["vehicles"][0]["vehicle_id"] = "A1"
    listed["vehicles"][1]["vehicle_id"] = "A2"
    listed["vehicles"][2]["vehicle_id"] = "A3"
    assert count_active_vehicles(listed) == 2
    assert count_active_vehicles({"ok": True}) == 0
    assert count_active_vehicles(None) == 0


def test_report_dates_reads_the_fleets_own_clock_newest_first():
    raw = batch(active_frame(0, "2026-08-28 10:00:00"), active_frame(1, "2026-08-21 09:00:00"))
    assert report_dates(raw, IST) == ["2026-08-28", "2026-08-21"]
    # epoch seconds are read in the source zone (the `date` filter is IST-local)
    epoch = datetime(2026, 8, 28, 4, 30, tzinfo=ZoneInfo("UTC")).timestamp()  # 10:00 IST
    assert report_dates({"vehicles": {"A1": {"last_updated": epoch}}}, IST) == ["2026-08-28"]
    # unusable timestamps are skipped, not fatal
    assert report_dates({"vehicles": {"A1": {"last_updated": "not a date"}}}, IST) == []
    assert report_dates({"vehicles": {"A1": {"last_updated": None}}}, IST) == []
    assert report_dates(dead_batch(0), IST) == []
    many = {f"A{i}": active_frame(0, f"2026-08-{day:02d} 10:00:00") for i, day in enumerate(range(1, 12))}
    assert len(report_dates({"vehicles": many}, IST, limit=4)) == 4


# ----------------------------------------------------------------- resolver
def test_healthy_configured_date_is_a_single_request():
    settings = make_settings(api_date="2026-09-01")
    client = FakeClient({"2026-09-01": active_batch(6)})
    extractor = make_extractor(settings, client)

    raw = extractor._fetch()
    assert client.calls == ["2026-09-01"]
    assert count_active_vehicles(raw) == 6
    plan = extractor.date_resolution
    assert plan is not None and plan.source == "configured" and plan.satisfied
    assert plan.resolved_date == "2026-09-01" and plan.probes == 1

    # steady state: the cached plan keeps every later poll at exactly one GET
    extractor._fetch()
    assert client.calls == ["2026-09-01", "2026-09-01"]


def test_healthy_unset_date_uses_the_server_default_once():
    settings = make_settings()
    client = FakeClient({None: active_batch(6)})
    extractor = make_extractor(settings, client)

    extractor._fetch()
    assert client.calls == [None]
    plan = extractor.date_resolution
    assert plan is not None and plan.source == "server-default" and plan.resolved_date is None


def test_dead_default_resolves_through_the_fleets_report_date():
    settings = make_settings()
    client = FakeClient(
        {
            None: dead_batch(2, "2026-08-28 10:00:00"),
            "2026-08-28": active_batch(6, "2026-08-28 10:00:00"),
        }
    )
    extractor = make_extractor(settings, client)

    raw = extractor._fetch()
    assert client.calls[0] is None
    assert client.calls[-1] == "2026-08-28"  # final slot reserved for the known fleet
    assert len(client.calls) == settings.live_date_max_probes
    plan = extractor.date_resolution
    assert plan is not None and plan.source == "report-date" and plan.satisfied
    assert plan.resolved_date == "2026-08-28" and plan.probes == len(client.calls)
    assert count_active_vehicles(raw) == 6


def test_dead_default_resolves_through_the_walkback_tier():
    live = days_ago_ist(1)
    settings = make_settings()
    client = FakeClient(
        {
            None: dead_batch(2, "2025-01-01 10:00:00"),
            "2025-01-01": dead_batch(2, "2025-01-01 10:00:00"),
            today_ist(): dead_batch(2, f"{today_ist()} 09:00:00"),
            live: active_batch(6),
        }
    )
    extractor = make_extractor(settings, client)

    extractor._fetch()
    assert client.calls == [None, today_ist(), live]  # newer dates before an old reporting hint
    plan = extractor.date_resolution
    assert plan is not None and plan.source == "walkback" and plan.satisfied
    assert plan.resolved_date == live


def test_stale_configured_date_falls_back_to_the_server_default():
    settings = make_settings(api_date="2026-08-21")
    client = FakeClient(
        {
            "2026-08-21": dead_batch(2, "2026-08-21 10:00:00"),
            None: active_batch(6),
        }
    )
    extractor = make_extractor(settings, client)

    extractor._fetch()
    assert client.calls == ["2026-08-21", None]
    plan = extractor.date_resolution
    assert plan is not None and plan.source == "server-default" and plan.satisfied


def test_best_effort_keeps_the_richest_batch_instead_of_nothing():
    settings = make_settings(live_date_max_probes=4)
    client = FakeClient(
        {
            None: dead_batch(2, "2026-08-28 10:00:00"),
            "2026-08-28": active_batch(3, "2026-08-28 10:00:00"),
        }
    )
    extractor = make_extractor(settings, client)

    raw = extractor._fetch()
    assert len(client.calls) == 4  # budget spent, nothing reached the threshold
    plan = extractor.date_resolution
    assert plan is not None and not plan.satisfied
    assert plan.resolved_date == "2026-08-28" and plan.active_vehicles == 3
    assert count_active_vehicles(raw) == 3  # the thin batch, honestly, not {}


def test_best_effort_reuses_its_batch_inside_the_reprobe_window():
    settings = make_settings(live_date_max_probes=3, live_date_reprobe_seconds=3600)
    client = FakeClient(
        {
            None: dead_batch(2, "2026-08-28 10:00:00"),
            "2026-08-28": active_batch(3, "2026-08-28 10:00:00"),
        }
    )
    extractor = make_extractor(settings, client)

    extractor._fetch()
    spent = len(client.calls)
    extractor._fetch()
    assert client.calls[spent:] == [None, "2026-08-28"], "check today and cached best-effort, not the entire search"

    settings_fast = make_settings(live_date_max_probes=3, live_date_reprobe_seconds=0)
    client_fast = FakeClient(
        {
            None: dead_batch(2, "2026-08-28 10:00:00"),
            "2026-08-28": active_batch(3, "2026-08-28 10:00:00"),
        }
    )
    extractor_fast = make_extractor(settings_fast, client_fast)
    extractor_fast._fetch()
    spent_fast = len(client_fast.calls)
    extractor_fast._fetch()
    assert len(client_fast.calls) > spent_fast + 1, "an elapsed window must re-probe"


def test_degraded_plan_triggers_a_fresh_resolution():
    settings = make_settings(api_date="2026-09-01")
    client = FakeClient({"2026-09-01": active_batch(6, "2026-09-01 10:00:00")})
    extractor = make_extractor(settings, client)
    extractor._fetch()
    assert extractor.date_resolution.satisfied is True
    assert extractor.date_resolution.source == "configured"

    # the upstream archive goes quiet: the cached date now answers dead,
    # while the server default still holds the live fleet
    client.batches["2026-09-01"] = dead_batch(2, "2026-09-01 10:00:00")
    client.batches[None] = active_batch(6)
    extractor._fetch()
    plan = extractor.date_resolution
    assert plan is not None and plan.satisfied and plan.source == "server-default"
    assert client.calls[-1] is None


def test_failing_probe_is_skipped_not_fatal():
    live = days_ago_ist(1)
    settings = make_settings()
    client = FakeClient(
        {
            None: dead_batch(2, "2026-08-28 10:00:00"),
            today_ist(): dead_batch(2),
            live: active_batch(6),
        },
        errors={today_ist(): UpstreamClientError("bad date", status_code=400)},
    )
    extractor = make_extractor(settings, client)

    extractor._fetch()
    plan = extractor.date_resolution
    assert plan is not None and plan.satisfied and plan.resolved_date == live
    assert today_ist() in client.calls  # probed, failed, skipped
    assert plan.probe_errors == 1
    assert plan.probes == len(client.calls)


def test_every_probe_failing_surfaces_the_transport_error():
    settings = make_settings()
    client = FakeClient({}, error_all=True)
    extractor = make_extractor(settings, client)
    with pytest.raises(RetryableUpstreamError):
        extractor._fetch()


def test_resolver_is_disabled_by_live_date_fallback_flag():
    settings = make_settings(live_date_fallback=False)
    client = FakeClient({None: dead_batch(2)})
    extractor = make_extractor(settings, client)
    raw = extractor._fetch()
    assert client.calls == [None]
    assert count_active_vehicles(raw) == 0


# ------------------------------------------------- mock-server integration
def test_scenario_mock_end_to_end_resolution():
    """Against the real HTTP mock in scenario mode: dead today, live yesterday.

    The engine must walk from the dead server-default batch to the live
    archive date on its own and ingest the full two-tier fleet from there.
    """
    import threading

    import requests

    from telemetry.api import UpstreamClient
    from tools.mock_server import PASSCODE, SECRET_KEY, make_server

    server = make_server(port=0, vehicles=6, all_fields=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    live = days_ago_ist(1)
    try:
        reply = requests.post(f"{base}/__control/scenario", params={"live_date": live, "dead": 2}, timeout=5).json()
        assert reply["scenario"] == {"live_date": live, "dead": 2}

        settings = Settings(
            _env_file=None,
            api_base_url=base,
            api_secret_key=SECRET_KEY,
            api_passcode=PASSCODE,
            database_url="sqlite://",
            backoff_base_seconds=0.001,
        )
        client = UpstreamClient(settings)
        extractor = TelemetryExtractor(settings, client, TokenManager(settings, client))

        payload = extractor.fetch_only()
        plan = extractor.date_resolution
        assert plan is not None and plan.satisfied, plan
        assert plan.resolved_date == live
        assert plan.source == "walkback"
        assert plan.active_vehicles == 6
        assert len(payload.vehicles) == 6
        # two-tier enrichment still lands the battery block from the archive
        # date: the raw merged frame carries the v1 keys, and validation maps
        # them onto the canonical columns.
        frame = next(iter(payload.vehicles.values()))
        assert frame.get("batt_v") is not None
        assert frame.get("chg_status") is not None
        validated = extractor._validate_vehicles(payload, datetime.now())
        assert validated.accepted == 6
        values = validated.ok[0].values
        assert values["battery_total_v"] is not None
        assert values["charging_status"] is not None
    finally:
        requests.post(f"{base}/__control/scenario", params={"on": 0}, timeout=5)
        server.shutdown()
        server.server_close()


# ------------------------------- tier-2 merge honesty (nested battery block)
def test_merge_keeps_summary_values_when_detail_battery_carries_nulls():
    summary = {"last_updated": "2026-09-01 10:00:00", "soc": 55, "battery_total_v": 512.4, "battery": None}
    detail = {
        "last_updated": "2026-09-01 10:00:00",
        "soc": 55,
        "battery": {"batt_v": None, "chg_status": 0, "batt_temp": 31.2},
    }
    merged = merge_vehicle_frames(summary, detail)
    assert merged["battery_total_v"] == 512.4, "a nested null must not erase a live summary reading"
    assert merged["chg_status"] == 0, "a real 0 from the detail is a reading, not an absence"
    assert merged["batt_temp"] == 31.2
    assert "battery" not in merged

    parsed = parse_payload(VehiclesPayload.model_validate({"ok": True, "vehicles": {"AP39WG5383": merged}}), IST)
    values = parsed.ok[0].values
    assert values["battery_total_v"] == 512.4
    assert values["charging_status"] == 0
    assert values["battery_temp_c"] == 31.2
    assert values["soc"] == 55


# Regression: a healthy historical winner used to be cached indefinitely.
def test_a_new_current_fleet_wins_next_poll_even_when_cached_archive_is_healthy():
    old = days_ago_ist(2)
    client = FakeClient({None: dead_batch(2, f"{old} 10:00:00"), old: active_batch(6, f"{old} 10:00:00")})
    extractor = make_extractor(make_settings(), client)
    extractor._fetch()
    assert extractor.date_resolution.resolved_date == old
    spent = len(client.calls)
    client.batches[None] = active_batch(6, f"{today_ist()} 10:00:00")
    extractor._fetch()
    assert client.calls[spent:] == [None]
    assert extractor.date_resolution.source == "server-default"
    assert extractor.date_resolution.resolved_date is None


def test_a_newer_archive_wins_next_poll_while_old_archive_still_has_a_full_fleet():
    old, newer = days_ago_ist(3), days_ago_ist(1)
    client = FakeClient({None: dead_batch(2, f"{old} 10:00:00"), old: active_batch(6, f"{old} 10:00:00")})
    extractor = make_extractor(make_settings(), client)
    extractor._fetch()
    assert extractor.date_resolution.resolved_date == old
    client.batches[newer] = active_batch(6, f"{newer} 10:00:00")
    extractor._fetch()
    assert extractor.date_resolution.resolved_date == newer


def test_reporting_hints_are_never_reversed_oldest_first():
    newer, older = days_ago_ist(2), days_ago_ist(4)
    client = FakeClient({None: batch(dead_frame(f"{newer} 10:00:00"), dead_frame(f"{older} 10:00:00")),
                         newer: active_batch(6), older: active_batch(6)})
    extractor = make_extractor(make_settings(live_date_probe_days=1), client)
    extractor._fetch()
    assert extractor.date_resolution.resolved_date == newer
    assert older not in client.calls


def test_failed_requests_count_against_the_hard_probe_budget():
    client = FakeClient({}, error_all=True)
    extractor = make_extractor(make_settings(live_date_max_probes=3), client)
    with pytest.raises(RetryableUpstreamError):
        extractor._fetch()
    assert len(client.calls) == 3


def test_best_effort_cooldown_does_not_hide_new_current_data():
    old = days_ago_ist(2)
    client = FakeClient({None: dead_batch(2, f"{old} 10:00:00"), old: active_batch(3)})
    extractor = make_extractor(make_settings(live_date_reprobe_seconds=3600), client)
    extractor._fetch()
    assert not extractor.date_resolution.satisfied
    client.batches[None] = active_batch(6)
    extractor._fetch()
    assert extractor.date_resolution.satisfied
    assert extractor.date_resolution.resolved_date is None


def test_blank_date_means_the_default_not_an_empty_pinned_filter():
    assert make_settings(api_date="  ").api_date is None
