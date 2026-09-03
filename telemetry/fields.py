"""Single source of truth for the 24 extracted parameters.

Why this file exists
--------------------
The live contract (verified against the production API via Postman, 2026-09)
is **two-tier**:

  * Tier 1 -- `GET /api/v1/vehicles` returns a high-level fleet summary.  Each
    vehicle frame carries the operational keys (SOC, odo, speed, GPS, ...) and
    an explicitly `"battery": null` block.
  * Tier 2 -- `GET /api/v1/vehicles/{vehicle_id}` returns the complete live
    diagnostic frame, including the battery block, under the *abbreviated v1
    key names* (`batt_v`, `chg_status`, `batt_temp`, ...).

Rather than hard-coding guesses in three places (model, schema, SQL), every
parameter is declared ONCE here with:

  * its canonical name (== column name in PostgreSQL),
  * the ordered set of accepted upstream aliases -- legacy guide keys AND the
    live v1 abbreviations (confirmed ones first where they exist),
  * its type / range / precision,
  * whether it is monotonic (used by the upsert's anti-regression guard),
  * whether at least one key is confirmed upstream (`documented`).

The Pydantic model, the SQLAlchemy ORM and the upsert statement are all
generated from this registry, so renaming a column or accepting a new alias is
a one-line change.

Dynamic resolution
------------------
Beyond the exact alias table, `resolve_parameter_key` normalises incoming keys
(lowercase, separators stripped), so `BATT_V`, `batt-v` and `batt_v` all
resolve to `battery_total_v` without a per-spelling entry.  Any key that still
resolves to nothing is reported by `telemetry.mapping.DriftReporter`, so a
future upstream rename is one log line away from being mapped.

NULL policy (revised 2026-09)
-----------------------------
No parameter is pinned NULL any more.  A parameter is NULL **only** when the
merged tier-1 + tier-2 frame genuinely does not carry any of its keys (or
carries an unusable sentinel).  Values the upstream sends are parsed and
stored, never overridden.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final


@dataclass(frozen=True, slots=True)
class ParamSpec:
    """Declaration of one telemetry parameter."""

    name: str                     # canonical name, used as DB column + Pydantic field
    label: str                    # human label (product spec wording)
    unit: str                     # display unit, "" for dimensionless
    kind: str                     # "float" | "int" | "str"
    aliases: tuple[str, ...]      # accepted upstream JSON keys, best guess first
    minimum: float | None = None
    maximum: float | None = None
    monotonic: bool = False       # counter-like: a decrease means a bad/rolled-back reading
    documented: bool = False      # True => at least one key confirmed against the live API
    nullable: bool = True


def _f(name: str, label: str, unit: str, *aliases: str, **kw) -> ParamSpec:
    return ParamSpec(name=name, label=label, unit=unit, kind="float", aliases=(name, *aliases), **kw)


def _i(name: str, label: str, unit: str, *aliases: str, **kw) -> ParamSpec:
    return ParamSpec(name=name, label=label, unit=unit, kind="int", aliases=(name, *aliases), **kw)


# ---------------------------------------------------------------------------
# THE 24 PARAMETERS (order == product spec order)
# ---------------------------------------------------------------------------
PARAM_SPECS: Final[tuple[ParamSpec, ...]] = (
    #  1  SOC (%)  -- present in the tier-1 fleet summary
    _f("soc", "SOC", "%", "state_of_charge", "batt_soc", "soc_pct", maximum=100, minimum=0, documented=True),
    #  2  SOH (%)
    _f("soh", "SOH", "%", "state_of_health", "batt_soh", maximum=150, minimum=0, documented=True),
    #  3  Odometer (km)  -- monotonic: an odo that goes backwards is a bad frame
    _f("odometer_km", "Odometer", "km", "odo", "odometer", "odo_km", minimum=0, monotonic=True, documented=True),
    #  4  Residual Mileage (km)
    _f("residual_mileage_km", "Residual Mileage", "km", "residual_mileage", "res_mileage", "res_km", minimum=0, documented=True),
    #  5  Charge Cycles -- monotonic counter
    _i("charge_cycles", "Charge Cycles", "", "cycles", "charge_cycle", "cycle_count", "chg_cycles", minimum=0, monotonic=True, documented=True),
    #  6  Battery Temperature (degC)  -- `batt_temp` confirmed in the live v1 frame
    _f("battery_temp_c", "Battery Temperature", "degC", "batt_temp", "battery_temperature", "temp", minimum=-40, maximum=120, documented=True),
    #  7  Minimum Cell Voltage (V)
    _f("min_cell_v", "Minimum Cell Voltage", "V", "min_cell_voltage", "cell_v_min", "min_v", minimum=0, maximum=6, documented=True),
    #  8  Maximum Cell Voltage (V)
    _f("max_cell_v", "Maximum Cell Voltage", "V", "max_cell_voltage", "cell_v_max", "max_v", minimum=0, maximum=6, documented=True),
    #  9  Maximum Temperature (degC)
    _f("max_temp_c", "Maximum Temperature", "degC", "max_temp", "temp_max", "max_temperature", "max_t", "mx_temp", minimum=-40, maximum=150),
    # 10  Minimum Temperature (degC)
    _f("min_temp_c", "Minimum Temperature", "degC", "min_temp", "temp_min", "min_temperature", "min_t", "mn_temp", minimum=-40, maximum=150),
    # 11  Power Regeneration (kWh)
    _f("regen_kwh", "Power Regeneration", "kWh", "power_regen_kwh", "regen_energy_kwh", minimum=0, documented=True),
    # 12  Vehicle Speed (km/h)
    _f("speed_kmh", "Vehicle Speed", "km/h", "speed", "vehicle_speed", "spd", minimum=0, maximum=250, documented=True),
    # 13  Total Power Consumption (kWh)
    _f("total_power_kwh", "Total Power Consumption", "kWh", "total_power_consumption_kwh", "tot_power_kwh", "tot_kwh", "power_kwh", "energy_kwh", minimum=0),
    # 14  Charging Status (0/1)  -- `chg_status` confirmed in the live v1 frame
    _i("charging_status", "Charging Status", "0/1", "chg_status", "charge_status", "chg_sts", "is_charging", minimum=0, maximum=1, documented=True),
    # 15  Battery Average Temperature (degC)
    _f("battery_avg_temp_c", "Battery Average Temperature", "degC", "avg_temp", "batt_avg_temp", "batt_avg_t", "battery_average_temp", minimum=-40, maximum=150),
    # 16  Battery Total Voltage (V)  -- `batt_v` confirmed in the live v1 frame
    _f("battery_total_v", "Battery Total Voltage", "V", "batt_v", "batt_volt", "total_v", "pack_v", "batt_total_v", "battery_voltage", minimum=0, maximum=1500, documented=True),
    # 17  Battery Current (A)  -- can be negative (regen/discharge convention)
    _f("battery_current_a", "Battery Current", "A", "batt_a", "batt_cur", "batt_current", "batt_amp", "pack_current_a", minimum=-3000, maximum=3000),
    # 18  Maximum Cell Voltage Cell Number
    _i("max_cell_v_cell_no", "Max Cell Voltage Cell Number", "", "max_cell_v_cell_number", "max_cell_no", "max_v_cell_no", "mx_cell_no", minimum=0, maximum=4096),
    # 19  Minimum Cell Voltage Battery Number
    _i("min_cell_v_pack_no", "Min Cell Voltage Battery Number", "", "min_cell_v_battery_number", "min_pack_no", "min_v_pack_no", "mn_pack_no", minimum=0, maximum=64),
    # 20  Minimum Cell Voltage Cell Number
    _i("min_cell_v_cell_no", "Min Cell Voltage Cell Number", "", "min_cell_v_cell_number", "min_cell_no", "min_v_cell_no", "mn_cell_no", minimum=0, maximum=4096),
    # 21  Maximum Temperature Battery Number
    _i("max_temp_pack_no", "Max Temperature Battery Number", "", "max_temp_battery_number", "max_pack_no", "max_t_pack", "max_t_pack_no", "mx_t_pack", minimum=0, maximum=64),
    # 22  Vehicle Work Status  -- upstream type unknown, stored verbatim as text
    ParamSpec(
        name="work_status",
        label="Vehicle Work Status",
        unit="",
        kind="str",
        aliases=("work_status", "work_sts", "vehicle_work_status", "wrk_status", "veh_work_status", "workstate"),
        nullable=True,
    ),
    # 23  Latitude
    _f("latitude", "Latitude", "deg", "lat", minimum=-90, maximum=90),
    # 24  Longitude
    _f("longitude", "Longitude", "deg", "lon", "lng", minimum=-180, maximum=180),
)

assert len(PARAM_SPECS) == 24, f"expected 24 parameters, got {len(PARAM_SPECS)}"

# canonical name -> spec
SPEC_BY_NAME: Final[dict[str, ParamSpec]] = {p.name: p for p in PARAM_SPECS}

# upstream key -> canonical name (drives the "unknown key" drift detector)
ALIAS_TO_NAME: Final[dict[str, str]] = {
    alias.lower(): p.name for p in PARAM_SPECS for alias in p.aliases
}

# keys whose presence/absence the guide actually documents; `battery` is the
# tier-1 block placeholder (null in summaries, populated in tier-2 details).
META_FIELDS: Final[tuple[str, ...]] = ("last_updated", "battery")

MONOTONIC_NAMES: Final[tuple[str, ...]] = tuple(p.name for p in PARAM_SPECS if p.monotonic)

# Every field the Pydantic model will emit (24 params + vehicle timestamp).
COLUMN_NAMES: Final[tuple[str, ...]] = tuple(p.name for p in PARAM_SPECS)


# ---------------------------------------------------------------------------
# dynamic key resolution
# ---------------------------------------------------------------------------
def normalize_key(key: str) -> str:
    """`BATT-V`, ` batt_v ` and `battV` all normalise to `battv`."""
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _build_normalized_alias_map() -> dict[str, str]:
    """normalized key -> canonical name, first declaration wins."""
    mapping: dict[str, str] = {}
    for spec in PARAM_SPECS:
        for variant in (*spec.aliases, spec.name):
            mapping.setdefault(normalize_key(variant), spec.name)
    return mapping


NORMALIZED_ALIAS_TO_NAME: Final[dict[str, str]] = _build_normalized_alias_map()


def resolve_parameter_key(key: str) -> str | None:
    """Map one raw upstream key to its canonical parameter, or None.

    Exact alias match first (fast path), then the normalized table so case and
    separator variants of a known alias resolve without per-spelling entries.
    """
    direct = ALIAS_TO_NAME.get(key.lower())
    if direct is not None:
        return direct
    return NORMALIZED_ALIAS_TO_NAME.get(normalize_key(key))


def spec(name: str) -> ParamSpec:
    return SPEC_BY_NAME[name]
