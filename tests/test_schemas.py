"""Pydantic validation: aliases, coercion, quarantine, timestamp handling."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from telemetry.fields import COLUMN_NAMES, PARAM_SPECS
from telemetry.schemas import (
    AuthResponse,
    VehiclesPayload,
    VehicleParams,
    flatten_vehicle_frame,
    merge_vehicle_frames,
    parse_payload,
    parse_source_timestamp,
)

IST = ZoneInfo("Asia/Kolkata")

# The exact frame from DASHBOARD_API_GUIDE.md section 3.
GUIDE_FRAME = {
    "last_updated": "2026-08-21 10:14:52",
    "soc": 78,
    "soh": 96.5,
    "odo": 41230,
    "residual_mileage": 114,
    "cycles": 312,
    "batt_temp": 34,
    "min_cell_v": 3.31,
    "max_cell_v": 3.36,
    "speed": 0,
    "regen_kwh": 12.4,
}

FULL_FRAME = {
    **GUIDE_FRAME,
    "max_temp_c": 38.2,
    "min_temp_c": 29.4,
    "total_power_kwh": 1580.75,
    "charging_status": 1,
    "battery_avg_temp_c": 33.8,
    "battery_total_v": 521.4,
    "battery_current_a": -86.5,
    "max_cell_v_cell_no": 42,
    "min_cell_v_pack_no": 2,
    "min_cell_v_cell_no": 117,
    "max_temp_pack_no": 3,
    "work_status": "CHARGING",
    "latitude": 18.7,
    "longitude": 80.1,
}


def _parse(frame, **kwargs):
    payload = VehiclesPayload(ok=True, vehicles={"AP39WG5383": frame})
    kwargs.setdefault("ingest_time", datetime(2026, 8, 21, 5, 0, tzinfo=timezone.utc))
    return parse_payload(payload, IST, **kwargs)


# ------------------------------------------------------------------ coverage
def test_guide_frame_maps_documented_fields():
    result = _parse(GUIDE_FRAME)
    assert result.accepted == 1 and not result.rejected
    values = result.ok[0].values
    assert values["soc"] == 78
    assert values["soh"] == 96.5
    assert values["odometer_km"] == 41230
    assert values["residual_mileage_km"] == 114
    assert values["charge_cycles"] == 312
    assert values["battery_temp_c"] == 34
    assert values["min_cell_v"] == 3.31
    assert values["max_cell_v"] == 3.36
    assert values["speed_kmh"] == 0
    assert values["regen_kwh"] == 12.4


def test_full_frame_populates_all_24_parameters():
    """A frame that carries all 24 keys stores all 24 values.

    Nothing is pinned NULL any more: what the live tier-2 feed sends is what
    the database gets."""
    result = _parse(FULL_FRAME)
    assert result.accepted == 1, result.rejected
    vehicle = result.ok[0]

    assert len(vehicle.values) == 24
    assert all(name in vehicle.values for name in (p.name for p in PARAM_SPECS))
    for name in COLUMN_NAMES:
        assert vehicle.values[name] is not None, f"{name} must be populated, got NULL"

    # a complete frame reports neither missing keys nor field errors
    assert vehicle.missing == []
    assert vehicle.field_errors == []


def test_every_parameter_accepts_its_canonical_name():
    """The DB column name must also be a valid input key (round-tripping)."""
    frame = {name: 1 for name in COLUMN_NAMES}
    result = _parse(frame)
    assert result.accepted == 1, result.rejected
    assert result.ok[0].missing == []
    for name in COLUMN_NAMES:
        assert result.ok[0].values[name] is not None, name


# ------------------------------------------------- live v1 mapping (two-tier)
def test_v1_abbreviated_keys_map_to_canonical_columns():
    """`batt_v`, `chg_status`, `batt_a` etc. from the live detail feed land on
    the canonical columns the frontend and the ORM expect."""
    frame = {
        **GUIDE_FRAME,
        "batt_v": 512.4,
        "chg_status": 1,
        "batt_a": -86.5,
        "tot_power_kwh": 1580.75,
        "work_sts": "CHARGING",
    }
    result = _parse(frame)
    assert result.accepted == 1, result.rejected
    values = result.ok[0].values
    assert values["battery_total_v"] == 512.4
    assert values["charging_status"] == 1
    assert isinstance(values["charging_status"], int)
    assert values["battery_current_a"] == -86.5
    assert values["total_power_kwh"] == 1580.75
    assert values["work_status"] == "CHARGING"


def test_nested_battery_block_is_flattened_and_parsed():
    """The tier-2 detail nests diagnostics under `battery`; the validator
    consumes them transparently."""
    frame = {
        **GUIDE_FRAME,
        "battery": {
            "batt_v": 548.2,
            "chg_status": 0,
            "batt_a": 12.5,
            "max_cell_no": 42,
            "min_pack_no": 2,
            "min_cell_no": 117,
            "max_t_pack": 3,
            "work_sts": "RUNNING",
        },
    }
    result = _parse(frame)
    assert result.accepted == 1, result.rejected
    values = result.ok[0].values
    assert values["battery_total_v"] == 548.2
    assert values["charging_status"] == 0
    assert values["battery_current_a"] == 12.5
    assert values["max_cell_v_cell_no"] == 42
    assert values["min_cell_v_pack_no"] == 2
    assert values["min_cell_v_cell_no"] == 117
    assert values["max_temp_pack_no"] == 3
    assert values["work_status"] == "RUNNING"
    # the whole battery block was consumed: nothing missing from it
    assert not {"battery_total_v", "charging_status", "work_status"} & set(result.ok[0].missing)


def test_summary_battery_null_placeholder_is_ignored():
    """Tier-1 frames carry `"battery": null`; that placeholder must not become
    a field error or a parameter -- it is metadata."""
    frame = {**GUIDE_FRAME, "battery": None}
    result = _parse(frame)
    assert result.accepted == 1, result.rejected
    assert "battery" not in result.ok[0].values
    assert not any(e.field == "battery" for e in result.ok[0].field_errors)


def test_detail_nulls_never_erase_summary_values_in_merge():
    """`merge_vehicle_frames`: an explicit null in the detail response means
    'no reading' -- it must not wipe the tier-1 summary value."""
    summary = {"soc": 71.5, "odo": 40200.0, "battery": None}
    detail = {"soc": None, "batt_v": 509.9, "battery": {"chg_status": 1, "batt_a": None}}
    merged = merge_vehicle_frames(summary, detail)
    assert merged["soc"] == 71.5
    assert merged["batt_v"] == 509.9
    assert merged["chg_status"] == 1
    assert "battery" not in merged
    assert "batt_a" not in merged  # null in both tiers -> key absent -> NULL fallback


def test_merge_tolerates_envelope_and_non_dict_details():
    summary = {"soc": 71.5}
    assert merge_vehicle_frames(summary, {"ok": True, "vehicle": {"batt_v": 500.0}}) == {"soc": 71.5, "batt_v": 500.0}
    assert merge_vehicle_frames(summary, None) == summary
    assert merge_vehicle_frames(summary, "garbage") == summary
    assert flatten_vehicle_frame({"a": 1, "battery": {"b": 2, "nested": {"c": 3}, "nul": None}}) == {"a": 1, "b": 2}


def test_absent_keys_fall_back_to_null_and_are_reported():
    """The only NULL path left: the merged frame genuinely lacks the key."""
    result = _parse(GUIDE_FRAME)  # 10 params present, 14 absent
    vehicle = result.ok[0]
    assert vehicle.values["battery_total_v"] is None
    assert vehicle.values["work_status"] is None
    assert "battery_total_v" in vehicle.missing and "work_status" in vehicle.missing
    # absence is not junk: no field errors for the absent keys
    assert not any(e.field in {"battery_total_v", "work_status"} for e in vehicle.field_errors)


def test_case_and_separator_variants_resolve_dynamically():
    result = _parse({**GUIDE_FRAME, "BATT_V": 501.0, "Chg-Status": 1})
    assert result.accepted == 1, result.rejected
    values = result.ok[0].values
    assert values["battery_total_v"] == 501.0
    assert values["charging_status"] == 1


def test_unknown_keys_are_ignored_not_fatal():
    result = _parse({**GUIDE_FRAME, "brand_new_ecu_field": "hello", "another": 42})
    assert result.accepted == 1
    assert "brand_new_ecu_field" not in result.ok[0].values


# ------------------------------------------------------------------ coercion
def test_integer_parameters_stay_integers():
    # NOTE: this used to feed `charging_status: True` and expect 1 -- which was
    # the very coercion the P1 Boolean Trap fix now forbids.  The int-rounding
    # behaviour it covers is kept; boolean rejection has its own test below.
    result = _parse({**GUIDE_FRAME, "cycles": 312.0})
    values = result.ok[0].values
    assert values["charge_cycles"] == 312
    assert isinstance(values["charge_cycles"], int)


def test_numeric_strings_are_coerced():
    result = _parse({**GUIDE_FRAME, "soc": "77", "soh": "96.5"})
    assert result.ok[0].values["soc"] == 77
    assert result.ok[0].values["soh"] == 96.5


def test_nullish_sentinels_become_null_without_failing():
    result = _parse({**GUIDE_FRAME, "soc": "", "soh": "N/A", "speed": "-", "batt_temp": "null"})
    values = result.ok[0].values
    assert result.accepted == 1
    assert values["soc"] is None and values["soh"] is None
    assert values["speed_kmh"] is None and values["battery_temp_c"] is None
    # ...and they are reported, not silently swallowed
    assert {e.field for e in result.ok[0].field_errors} == {"soc", "soh", "speed_kmh", "battery_temp_c"}


def test_out_of_range_is_a_validation_failure_not_a_silent_write():
    """soc=480 is a broken sensor; it must not reach the database as 480."""
    result = _parse({**GUIDE_FRAME, "soc": 480})
    assert result.accepted == 0
    assert result.rejected[0].vehicle_id == "AP39WG5383"
    assert any("soc" in e.field for e in result.rejected[0].errors)


def test_negative_values_are_allowed_on_measured_fields():
    """Sub-zero cell temperature and southern-hemisphere coordinates are real."""
    result = _parse({**GUIDE_FRAME, "batt_temp": -5.5, "lat": -12.25})
    values = result.ok[0].values
    assert values["battery_temp_c"] == -5.5
    assert values["latitude"] == -12.25


def test_battery_current_accepts_v1_and_canonical_keys():
    """`battery_current_a` is live telemetry now: both the v1 key and the
    canonical column parse into real values."""
    via_v1 = _parse({**GUIDE_FRAME, "batt_a": -120.5})
    via_canonical = _parse({**GUIDE_FRAME, "battery_current_a": -120.5})
    assert via_v1.ok[0].values["battery_current_a"] == -120.5
    assert via_canonical.ok[0].values["battery_current_a"] == -120.5


# ------------------------------------------- P1 regression coverage (handoff)
def test_p1_in_bounds_integer_is_accepted():
    """A documented, in-bounds counter must still pass (no over-rejection)."""
    result = _parse({**GUIDE_FRAME, "cycles": 312})
    assert result.accepted == 1, result.rejected
    assert result.ok[0].values["charge_cycles"] == 312
    assert isinstance(result.ok[0].values["charge_cycles"], int)


def test_p1_out_of_bounds_integer_fails_the_bounds_check():
    """Integer fields used to return before min/max ran.

    `charge_cycles` is a monotonic integer; the alias layer re-keys the frame
    onto canonical names first, so validation errors report the canonical
    column -- one consistent name end to end.
    """
    result = _parse({**GUIDE_FRAME, "cycles": -5})
    assert result.accepted == 0, "charge_cycles=-5 slipped past minimum=0"
    rejected = result.rejected[0]
    assert any(
        e.field == "charge_cycles" and "below minimum" in e.error for e in rejected.errors
    ), rejected.errors


def test_p1_out_of_range_float_fails_the_bounds_check():
    """A coordinate outside the physical range must not reach the database."""
    result = _parse({**GUIDE_FRAME, "lat": -95})
    assert result.accepted == 0, "latitude=-95 slipped past minimum=-90"
    rejected = result.rejected[0]
    assert any("below minimum" in e.error for e in rejected.errors), rejected.errors


def test_p1_junk_on_battery_channels_is_quarantined_like_any_channel():
    """The former 'unmeasured' channels are ordinary validated fields now:
    an out-of-range value (chg_status=2, negative cell number) quarantines the
    frame exactly like soc=480 does -- it must not reach the database."""
    result = _parse({**GUIDE_FRAME, "charging_status": 2, "max_cell_v_cell_no": -5})
    assert result.accepted == 0, "out-of-range battery channels slipped past the bounds"
    rejected = result.rejected[0]
    flagged = {e.field for e in rejected.errors}
    assert "charging_status" in flagged and "max_cell_v_cell_no" in flagged, rejected.errors


def test_p1_boolean_in_numeric_field_is_rejected_not_coerced():
    """True/False must raise before any 1/0 coercion; the frame is quarantined."""
    result = _parse({**GUIDE_FRAME, "speed": True, "soc": False})
    assert result.accepted == 0, "booleans were coerced into numbers"
    rejected = result.rejected[0]
    # Pydantic reports the input key in `loc`, so the field name is the alias
    # we sent ("speed"), not the canonical column name ("speed_kmh").
    flagged = {e.field for e in rejected.errors}
    assert "soc" in flagged, rejected.errors
    assert "speed" in flagged or "speed_kmh" in flagged, rejected.errors
    assert all("boolean" in e.error for e in rejected.errors)


# ----------------------------------------------------------------- isolation
def test_one_bad_vehicle_does_not_sink_the_fleet():
    payload = VehiclesPayload(
        ok=True,
        vehicles={
            "AP39WG5383": GUIDE_FRAME,
            "AP39WH5376": {**GUIDE_FRAME, "soc": 999},
            "AP39WJ2210": "not-an-object",
            "x": GUIDE_FRAME,  # malformed id
        },
    )
    result = parse_payload(payload, IST, ingest_time=datetime.now(timezone.utc))
    assert result.seen == 4
    assert result.accepted == 1
    assert {r.vehicle_id for r in result.rejected} == {"AP39WH5376", "AP39WJ2210", "X"}


def test_require_all_fields_mode_rejects_partial_frames():
    """The strict gate counts all 24 parameters: the guide frame carries 10
    (11 keys minus the timestamp), so 14 are missing."""
    result = _parse(GUIDE_FRAME, require_all_fields=True)
    assert result.accepted == 0
    reason = result.rejected[0].reason
    assert "missing 14 required parameter(s)" in reason
    assert "soc" not in reason.split(":")[1], "present parameters must not be counted as missing"


def test_require_all_fields_accepts_complete_frames():
    assert _parse(FULL_FRAME, require_all_fields=True).accepted == 1


# --------------------------------------------------------------- timestamps
def test_naive_ist_timestamp_is_stored_as_utc():
    result = _parse(GUIDE_FRAME)
    observed = result.ok[0].observed_at
    assert observed == datetime(2026, 8, 21, 4, 44, 52, tzinfo=timezone.utc)
    assert observed.utcoffset().total_seconds() == 0


def test_missing_timestamp_falls_back_to_ingest_time():
    frame = {k: v for k, v in GUIDE_FRAME.items() if k != "last_updated"}
    ingest = datetime(2026, 8, 21, 6, 0, tzinfo=timezone.utc)
    result = _parse(frame, ingest_time=ingest, fallback_observed_at="ingest")
    assert result.ok[0].observed_at == ingest


def test_missing_timestamp_can_drop_the_frame_instead():
    frame = {k: v for k, v in GUIDE_FRAME.items() if k != "last_updated"}
    result = _parse(frame, fallback_observed_at="drop")
    assert result.ok[0].observed_at is None


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("2026-08-21 10:14:52", "2026-08-21T04:44:52+00:00"),
        ("2026-08-21T10:14:52", "2026-08-21T04:44:52+00:00"),
        ("2026-08-21T10:14:52Z", "2026-08-21T10:14:52+00:00"),
        ("2026-08-21T10:14:52+05:30", "2026-08-21T04:44:52+00:00"),
        (1787796892, "2026-08-27T02:14:52+00:00"),
        ("nonsense", None),
        ("", None),
        (None, None),
    ],
)
def test_timestamp_parsing(raw, expected):
    parsed = parse_source_timestamp(raw, IST)
    assert (parsed.isoformat() if parsed else None) == expected


def test_vehicle_id_is_normalised_to_uppercase():
    payload = VehiclesPayload(ok=True, vehicles={"ap39wg5383": GUIDE_FRAME})
    result = parse_payload(payload, IST)
    assert result.ok[0].vehicle_id == "AP39WG5383"


# ------------------------------------------------------------------ envelope
def test_dashboard_envelope_tolerates_missing_vehicles():
    assert VehiclesPayload.model_validate({"ok": True}).vehicles == {}


def test_auth_response_validates_documented_shape():
    parsed = AuthResponse.model_validate(
        {"ok": True, "token": "3f2a9c" + "0" * 118 + "b71d", "token_type": "Bearer", "expires_in": 3540}
    )
    assert parsed.expires_in == 3540
    assert len(parsed.token) == 128


def test_auth_response_rejects_empty_token():
    with pytest.raises(Exception):
        AuthResponse.model_validate({"ok": True, "token": "   ", "expires_in": 3540})


def test_generated_model_has_one_field_per_parameter_plus_timestamp():
    assert len(VehicleParams.model_fields) == len(PARAM_SPECS) + 1


def test_bms_255_sentinel_coerces_to_none():
    """BMS not reported sentinel (255) must be stored as None on cell/pack indexing channels."""
    result = _parse(
        {
            **GUIDE_FRAME,
            "max_cv_cell": 255,
            "min_cv_cell": 255.0,
            "min_cv_batt": 255,
            "max_temp_batt": 255,
        }
    )
    assert result.accepted == 1
    values = result.ok[0].values
    assert values["max_cell_v_cell_no"] is None
    assert values["min_cell_v_cell_no"] is None
    assert values["min_cell_v_pack_no"] is None
    assert values["max_temp_pack_no"] is None


def test_valid_cell_number_is_preserved():
    """In-bounds cell and battery numbers should not be coerced to None."""
    result = _parse(
        {
            **GUIDE_FRAME,
            "max_cv_cell": 12,
            "min_cv_cell": 1,
            "min_cv_batt": 3,
            "max_temp_batt": 2,
        }
    )
    assert result.accepted == 1
    values = result.ok[0].values
    assert values["max_cell_v_cell_no"] == 12
    assert values["min_cell_v_cell_no"] == 1
    assert values["min_cell_v_pack_no"] == 3
    assert values["max_temp_pack_no"] == 2


def test_vehicles_payload_accepts_data_container():
    """Payloads wrapped in {"data": [...]} validate through VehiclesPayload."""
    raw = {
        "ok": True,
        "data": [
            {"vehicle": "AP39WG5383", **GUIDE_FRAME},
        ],
    }
    payload = VehiclesPayload.model_validate(raw)
    assert "AP39WG5383" in payload.vehicles


def test_merge_vehicle_frames_unpacks_live_parameters():
    """merge_vehicle_frames extracts parameters from /api/v1/vehicles/{id}/live envelopes."""
    summary = {"vehicle": "TEST1", "soc": 50.0, "speed": 0.0}
    detail = {
        "ok": True,
        "vehicle": "TEST1",
        "parameters": {
            "batt_volt": 630.0,
            "batt_temp": 28.5,
            "workst": 1,
            "max_cv_cell": 255.0,
        },
    }
    merged = merge_vehicle_frames(summary, detail)
    assert merged["batt_volt"] == 630.0
    assert merged["batt_temp"] == 28.5
    assert merged["workst"] == 1
    assert merged["max_cv_cell"] == 255.0
    assert merged["soc"] == 50.0

