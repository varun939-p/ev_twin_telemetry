"""Pydantic validation: aliases, coercion, quarantine, timestamp handling."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from telemetry.fields import PARAM_SPECS
from telemetry.schemas import (
    AuthResponse,
    DashboardPayload,
    VehicleParams,
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
    payload = DashboardPayload(ok=True, vehicles={"AP39WG5383": frame})
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


def test_full_frame_covers_all_24_parameters():
    result = _parse(FULL_FRAME)
    assert result.accepted == 1
    vehicle = result.ok[0]
    assert vehicle.missing == []
    assert vehicle.field_errors == []
    assert all(name in vehicle.values for name in (p.name for p in PARAM_SPECS))
    assert len(vehicle.values) == 24


def test_every_parameter_accepts_its_canonical_name():
    """The DB column name must also be a valid input key (round-tripping)."""
    frame = {p.name: 1 for p in PARAM_SPECS}
    frame["work_status"] = "RUNNING"
    result = _parse(frame)
    assert result.accepted == 1, result.rejected
    assert result.ok[0].missing == []


def test_unknown_keys_are_ignored_not_fatal():
    result = _parse({**GUIDE_FRAME, "brand_new_ecu_field": "hello", "another": 42})
    assert result.accepted == 1
    assert "brand_new_ecu_field" not in result.ok[0].values


# ------------------------------------------------------------------ coercion
def test_integer_parameters_stay_integers():
    # NOTE: this used to feed `charging_status: True` and expect 1 -- which was
    # the very coercion the P1 Boolean Trap fix now forbids.  The int-rounding
    # behaviour it covers is kept; boolean rejection has its own test below.
    result = _parse({**GUIDE_FRAME, "cycles": 312.0, "charging_status": 1})
    values = result.ok[0].values
    assert values["charge_cycles"] == 312
    assert isinstance(values["charge_cycles"], int)
    assert values["charging_status"] == 1
    assert isinstance(values["charging_status"], int)


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


def test_negative_current_is_allowed():
    """Discharge/regen conventions make battery current legitimately negative."""
    result = _parse({**GUIDE_FRAME, "battery_current_a": -120.5})
    assert result.ok[0].values["battery_current_a"] == -120.5


# ------------------------------------------- P1 regression coverage (handoff)
def test_p1_charging_status_of_one_is_accepted():
    """A documented, in-bounds flag value must still pass (no over-rejection)."""
    result = _parse({**GUIDE_FRAME, "charging_status": 1})
    assert result.accepted == 1, result.rejected
    assert result.ok[0].values["charging_status"] == 1
    assert isinstance(result.ok[0].values["charging_status"], int)


def test_p1_charging_status_of_two_fails_the_bounds_check():
    """Integer fields used to return before min/max ran; 2 must now be rejected."""
    result = _parse({**GUIDE_FRAME, "charging_status": 2})
    assert result.accepted == 0, "charging_status=2 slipped past maximum=1"
    rejected = result.rejected[0]
    assert any(
        e.field == "charging_status" and "above maximum" in e.error
        for e in rejected.errors
    ), rejected.errors


def test_p1_negative_cell_number_fails_the_bounds_check():
    """A cell index cannot be negative; the old int path skipped minimum=0."""
    result = _parse({**GUIDE_FRAME, "max_cell_v_cell_no": -5})
    assert result.accepted == 0, "max_cell_v_cell_no=-5 slipped past minimum=0"
    rejected = result.rejected[0]
    assert any(
        e.field == "max_cell_v_cell_no" and "below minimum" in e.error
        for e in rejected.errors
    ), rejected.errors


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
    payload = DashboardPayload(
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
    result = _parse(GUIDE_FRAME, require_all_fields=True)
    assert result.accepted == 0
    assert "missing 14 required parameter(s)" in result.rejected[0].reason


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
    payload = DashboardPayload(ok=True, vehicles={"ap39wg5383": GUIDE_FRAME})
    result = parse_payload(payload, IST)
    assert result.ok[0].vehicle_id == "AP39WG5383"


# ------------------------------------------------------------------ envelope
def test_dashboard_envelope_tolerates_missing_vehicles():
    assert DashboardPayload.model_validate({"ok": True}).vehicles == {}


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
