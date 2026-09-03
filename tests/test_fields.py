"""The 24-parameter registry: completeness, uniqueness, alias coverage."""

from __future__ import annotations

from telemetry.fields import (
    ALIAS_TO_NAME,
    COLUMN_NAMES,
    MEASURED_NAMES,
    MONOTONIC_NAMES,
    PARAM_SPECS,
    SPEC_BY_NAME,
    UNMEASURED,
    UNMEASURED_NAMES,
)

# Exactly what the product spec lists, in order.
EXPECTED_LABELS = [
    "SOC", "SOH", "Odometer", "Residual Mileage", "Charge Cycles",
    "Battery Temperature", "Minimum Cell Voltage", "Maximum Cell Voltage",
    "Maximum Temperature", "Minimum Temperature", "Power Regeneration",
    "Vehicle Speed", "Total Power Consumption", "Charging Status",
    "Battery Average Temperature", "Battery Total Voltage", "Battery Current",
    "Max Cell Voltage Cell Number", "Min Cell Voltage Battery Number",
    "Min Cell Voltage Cell Number", "Max Temperature Battery Number",
    "Vehicle Work Status", "Latitude", "Longitude",
]


def test_exactly_24_parameters():
    assert len(PARAM_SPECS) == 24
    assert len(COLUMN_NAMES) == 24


def test_every_spec_parameter_is_covered():
    assert [p.label for p in PARAM_SPECS] == EXPECTED_LABELS


def test_canonical_names_are_unique():
    assert len(set(COLUMN_NAMES)) == 24


def test_no_alias_collides_between_parameters():
    """Two parameters claiming the same upstream key would silently swap data."""
    seen: dict[str, str] = {}
    for spec in PARAM_SPECS:
        for alias in spec.aliases:
            assert alias not in seen, f"alias {alias!r} claimed by both {seen[alias]} and {spec.name}"
            seen[alias] = spec.name
    assert set(seen) == set(ALIAS_TO_NAME)


def test_documented_guide_keys_are_accepted():
    """Every key DASHBOARD_API_GUIDE.md shows must map to a parameter."""
    documented = {
        "soc", "soh", "odo", "residual_mileage", "cycles", "batt_temp",
        "min_cell_v", "max_cell_v", "speed", "regen_kwh",
    }
    for key in documented:
        assert key in ALIAS_TO_NAME, f"documented key {key!r} is not mapped"


def test_ranges_are_sane_for_ev_physics():
    soc = SPEC_BY_NAME["soc"]
    assert (soc.minimum, soc.maximum) == (0, 100)
    cell = SPEC_BY_NAME["min_cell_v"]
    assert cell.maximum == 6, "a single Li-ion cell above 6 V is a sensor fault"
    assert SPEC_BY_NAME["charging_status"].maximum == 1
    assert SPEC_BY_NAME["latitude"].minimum == -90
    assert SPEC_BY_NAME["longitude"].maximum == 180


def test_monotonic_counters_flagged():
    assert set(MONOTONIC_NAMES) == {"odometer_km", "charge_cycles"}


def test_work_status_is_text():
    assert SPEC_BY_NAME["work_status"].kind == "str"


# ------------------------------------------------- unmeasured declaration
# The 9 parameters confirmed absent on 100/100 frames of the verified
# production capture (blue_energy_response.json, 2026-08-28).
EXPECTED_UNMEASURED = {
    "total_power_kwh",
    "charging_status",
    "battery_total_v",
    "battery_current_a",
    "max_cell_v_cell_no",
    "min_cell_v_pack_no",
    "min_cell_v_cell_no",
    "max_temp_pack_no",
    "work_status",
}


def test_exactly_9_parameters_are_declared_unmeasured():
    assert set(UNMEASURED_NAMES) == EXPECTED_UNMEASURED
    assert len(UNMEASURED_NAMES) == 9
    assert UNMEASURED == frozenset(EXPECTED_UNMEASURED)


def test_measured_and_unmeasured_partition_the_registry():
    assert set(MEASURED_NAMES) | set(UNMEASURED_NAMES) == set(COLUMN_NAMES)
    assert not (set(MEASURED_NAMES) & set(UNMEASURED_NAMES))
    assert len(MEASURED_NAMES) == 15


def test_unmeasured_flag_matches_the_spec_objects():
    assert {p.name for p in PARAM_SPECS if p.unmeasured} == EXPECTED_UNMEASURED
