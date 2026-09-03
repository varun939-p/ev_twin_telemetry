"""Pydantic validation: aliases, coercion, quarantine, timestamp handling."""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from telemetry.fields import MEASURED_NAMES, PARAM_SPECS, UNMEASURED_NAMES
from telemetry.schemas import (
    AuthResponse,
    VehiclesPayload,
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


def test_full_frame_emits_all_24_keys_and_holds_the_9_unmeasured_as_null():
    """A frame that carries all 24 keys still stores NULL for the declared-
    unmeasured 9.  The NULL is a contract, not an accident of the payload."""
    result = _parse(FULL_FRAME)
    assert result.accepted == 1, result.rejected
    vehicle = result.ok[0]

    assert len(vehicle.values) == 24
    assert all(name in vehicle.values for name in (p.name for p in PARAM_SPECS))

    # the 15 measured parameters are populated ...
    for name in MEASURED_NAMES:
        assert vehicle.values[name] is not None, name
    # ... the 9 unmeasured ones are NULL, never 0
    for name in UNMEASURED_NAMES:
        assert vehicle.values[name] is None, f"{name} must be NULL, got {vehicle.values[name]!r}"

    # and both facts are reported, not silently applied
    assert set(vehicle.missing) == set(UNMEASURED_NAMES)
    assert {e.field for e in vehicle.field_errors} == set(UNMEASURED_NAMES)
    assert all("unmeasured" in e.error for e in vehicle.field_errors)


def test_every_measured_parameter_accepts_its_canonical_name():
    """The DB column name must also be a valid input key (round-tripping)."""
    frame = {name: 1 for name in MEASURED_NAMES}
    result = _parse(frame)
    assert result.accepted == 1, result.rejected
    assert result.ok[0].missing == list(UNMEASURED_NAMES)
    for name in MEASURED_NAMES:
        assert result.ok[0].values[name] is not None, name


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


def test_battery_current_is_held_null_while_it_is_unmeasured():
    """`battery_current_a` is one of the 9: a plausible reading is still NULL."""
    result = _parse({**GUIDE_FRAME, "battery_current_a": -120.5})
    assert result.accepted == 1, result.rejected
    assert result.ok[0].values["battery_current_a"] is None


# ------------------------------------------- P1 regression coverage (handoff)
def test_p1_in_bounds_integer_is_accepted():
    """A documented, in-bounds counter must still pass (no over-rejection)."""
    result = _parse({**GUIDE_FRAME, "cycles": 312})
    assert result.accepted == 1, result.rejected
    assert result.ok[0].values["charge_cycles"] == 312
    assert isinstance(result.ok[0].values["charge_cycles"], int)


def test_p1_out_of_bounds_integer_fails_the_bounds_check():
    """Integer fields used to return before min/max ran.

    Re-pointed from `charging_status` (now declared unmeasured and pinned NULL)
    to `charge_cycles`, a MEASURED monotonic integer, so the regression the test
    was written for is still actually guarded.
    """
    result = _parse({**GUIDE_FRAME, "cycles": -5})
    assert result.accepted == 0, "charge_cycles=-5 slipped past minimum=0"
    rejected = result.rejected[0]
    assert any(
        e.field == "cycles" and "below minimum" in e.error for e in rejected.errors
    ), rejected.errors


def test_p1_out_of_range_float_fails_the_bounds_check():
    """A coordinate outside the physical range must not reach the database."""
    result = _parse({**GUIDE_FRAME, "lat": -95})
    assert result.accepted == 0, "latitude=-95 slipped past minimum=-90"
    rejected = result.rejected[0]
    assert any("below minimum" in e.error for e in rejected.errors), rejected.errors


def test_p1_junk_in_an_unmeasured_field_does_not_sink_the_frame():
    """The other half of the P1 guard: an out-of-range value on one of the 9
    must NOT quarantine the vehicle.  The 15 measured readings are worth more
    than a channel we are not reading anyway."""
    result = _parse({**GUIDE_FRAME, "charging_status": 2, "max_cell_v_cell_no": -5})
    assert result.accepted == 1, f"frame was quarantined over unmeasured fields: {result.rejected}"
    assert not result.rejected
    vehicle = result.ok[0]
    assert vehicle.values["charging_status"] is None
    assert vehicle.values["max_cell_v_cell_no"] is None
    # ...and the junk is still visible
    assert {"charging_status", "max_cell_v_cell_no"} <= {e.field for e in vehicle.field_errors}
    # the measured readings survived
    assert vehicle.values["soc"] == 78 and vehicle.values["charge_cycles"] == 312


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
    """The gate counts only the 15 measured parameters -- the 9 unmeasured ones
    can never arrive, so including them would quarantine the entire fleet."""
    result = _parse(GUIDE_FRAME, require_all_fields=True)
    assert result.accepted == 0
    reason = result.rejected[0].reason
    assert "missing 5 required parameter(s)" in reason
    assert not any(name in reason for name in UNMEASURED_NAMES), reason


def test_require_all_fields_never_rejects_over_the_unmeasured_nine():
    """A frame carrying all 15 measured parameters passes even though 9 keys are
    absent -- that absence is the declared contract, not a defect."""
    result = _parse(FULL_FRAME, require_all_fields=True)
    assert result.accepted == 1, result.rejected
    assert set(result.ok[0].missing) == set(UNMEASURED_NAMES)


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
