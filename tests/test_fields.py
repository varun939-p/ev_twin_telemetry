"""The 24-parameter registry: completeness, uniqueness, alias coverage."""

from __future__ import annotations

from telemetry.fields import (
    ALIAS_TO_NAME,
    COLUMN_NAMES,
    MONOTONIC_NAMES,
    NORMALIZED_ALIAS_TO_NAME,
    PARAM_SPECS,
    SPEC_BY_NAME,
    normalize_key,
    resolve_parameter_key,
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


# --------------------------------------------- live v1 key mapping (Postman)
def test_confirmed_v1_keys_map_to_canonical_columns():
    """The abbreviated keys captured live from GET /api/v1/vehicles/{id}."""
    assert ALIAS_TO_NAME["batt_v"] == "battery_total_v"
    assert ALIAS_TO_NAME["chg_status"] == "charging_status"
    assert ALIAS_TO_NAME["batt_temp"] == "battery_temp_c"
    assert ALIAS_TO_NAME["batt_a"] == "battery_current_a"
    assert ALIAS_TO_NAME["tot_power_kwh"] == "total_power_kwh"
    assert ALIAS_TO_NAME["work_sts"] == "work_status"


def test_every_auxiliary_parameter_has_a_v1_style_alias():
    """The former 'unmeasured nine' must all be mappable from the detail feed."""
    nine = {
        "total_power_kwh", "charging_status", "battery_total_v",
        "battery_current_a", "max_cell_v_cell_no", "min_cell_v_pack_no",
        "min_cell_v_cell_no", "max_temp_pack_no", "work_status",
    }
    for name in nine:
        spec = SPEC_BY_NAME[name]
        assert len(spec.aliases) > 1, f"{name} has no upstream alias"
        assert spec.name in ALIAS_TO_NAME


def test_normalized_resolution_handles_case_and_separators():
    """Dynamic layer: BATT_V / batt-v / battV all resolve without per-spelling entries."""
    assert resolve_parameter_key("BATT_V") == "battery_total_v"
    assert resolve_parameter_key("Chg-Status") == "charging_status"
    assert resolve_parameter_key("  batt temp ") == "battery_temp_c"
    assert resolve_parameter_key("totally_unknown_key") is None
    assert resolve_parameter_key("123") is None


def test_normalized_alias_map_is_collision_free():
    """Two parameters normalising to the same key would silently swap data."""
    owners: dict[str, str] = {}
    for spec in PARAM_SPECS:
        for variant in (*spec.aliases, spec.name):
            normalized = normalize_key(variant)
            assert owners.get(normalized, spec.name) == spec.name, (
                f"normalized collision on {normalized!r}: {owners.get(normalized)} vs {spec.name}"
            )
            owners[normalized] = spec.name
    assert set(owners) == set(NORMALIZED_ALIAS_TO_NAME)


def test_battery_and_last_updated_are_meta_not_parameters():
    from telemetry.fields import META_FIELDS

    assert "battery" in META_FIELDS
    assert "last_updated" in META_FIELDS
    assert "battery" not in ALIAS_TO_NAME
