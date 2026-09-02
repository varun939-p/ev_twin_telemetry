"""Single source of truth for the 24 extracted parameters.

Why this file exists
--------------------
The upstream guide's sample frame carries 11 keys: 10 of the 24 parameters
(`soc`, `soh`, `odo`, `residual_mileage`, `cycles`, `batt_temp`, `min_cell_v`,
`max_cell_v`, `speed`, `regen_kwh`) plus the `last_updated` timestamp.  The
remaining **14 parameters** are required by the product spec but their upstream
keys are not in the guide -- their aliases below are inferred, and are flagged
`documented=False` so `python -m telemetry fields` marks them for verification.

Rather than hard-coding guesses in three places (model, schema, SQL), every
parameter is declared ONCE here with:

  * its canonical name (== column name in PostgreSQL),
  * the ordered set of accepted upstream aliases,
  * its type / range / precision,
  * whether it is monotonic (used by the upsert's anti-regression guard).

The Pydantic model, the SQLAlchemy ORM and the upsert statement are all
generated from this registry, so renaming a column or accepting a new alias is
a one-line change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final


@dataclass(frozen=True, slots=True)
class ParamSpec:
    """Declaration of one telemetry parameter."""

    name: str                     # canonical name, used as DB column + Pydantic field
    label: str                    # human label (product spec wording)
    unit: str                     # display unit, "" for dimensionless
    kind: str                     # "float" | "int"
    aliases: tuple[str, ...]      # accepted upstream JSON keys, best guess first
    minimum: float | None = None
    maximum: float | None = None
    monotonic: bool = False       # counter-like: a decrease means a bad/rolled-back reading
    documented: bool = False      # True => key confirmed by DASHBOARD_API_GUIDE.md
    nullable: bool = True


def _f(name: str, label: str, unit: str, *aliases: str, **kw) -> ParamSpec:
    return ParamSpec(name=name, label=label, unit=unit, kind="float", aliases=(name, *aliases), **kw)


def _i(name: str, label: str, unit: str, *aliases: str, **kw) -> ParamSpec:
    return ParamSpec(name=name, label=label, unit=unit, kind="int", aliases=(name, *aliases), **kw)


# ---------------------------------------------------------------------------
# THE 24 PARAMETERS (order == product spec order)
# ---------------------------------------------------------------------------
PARAM_SPECS: Final[tuple[ParamSpec, ...]] = (
    #  1  SOC (%)
    _f("soc", "SOC", "%", "state_of_charge", "batt_soc", maximum=100, minimum=0, documented=True),
    #  2  SOH (%)
    _f("soh", "SOH", "%", "state_of_health", "batt_soh", maximum=150, minimum=0, documented=True),
    #  3  Odometer (km)  -- monotonic: an odo that goes backwards is a bad frame
    _f("odometer_km", "Odometer", "km", "odo", "odometer", "odo_km", minimum=0, monotonic=True, documented=True),
    #  4  Residual Mileage (km)
    _f("residual_mileage_km", "Residual Mileage", "km", "residual_mileage", "res_mileage", minimum=0, documented=True),
    #  5  Charge Cycles -- monotonic counter
    _i("charge_cycles", "Charge Cycles", "", "cycles", "charge_cycle", "cycle_count", minimum=0, monotonic=True, documented=True),
    #  6  Battery Temperature (degC)
    _f("battery_temp_c", "Battery Temperature", "degC", "batt_temp", "battery_temperature", "temp", minimum=-40, maximum=120, documented=True),
    #  7  Minimum Cell Voltage (V)
    _f("min_cell_v", "Minimum Cell Voltage", "V", "min_cell_voltage", "cell_v_min", minimum=0, maximum=6, documented=True),
    #  8  Maximum Cell Voltage (V)
    _f("max_cell_v", "Maximum Cell Voltage", "V", "max_cell_voltage", "cell_v_max", minimum=0, maximum=6, documented=True),
    #  9  Maximum Temperature (degC)
    _f("max_temp_c", "Maximum Temperature", "degC", "max_temp", "temp_max", "max_temperature", minimum=-40, maximum=150),
    # 10  Minimum Temperature (degC)
    _f("min_temp_c", "Minimum Temperature", "degC", "min_temp", "temp_min", "min_temperature", minimum=-40, maximum=150),
    # 11  Power Regeneration (kWh)
    _f("regen_kwh", "Power Regeneration", "kWh", "power_regen_kwh", "regen_energy_kwh", minimum=0, documented=True),
    # 12  Vehicle Speed (km/h)
    _f("speed_kmh", "Vehicle Speed", "km/h", "speed", "vehicle_speed", minimum=0, maximum=250, documented=True),
    # 13  Total Power Consumption (kWh)
    _f("total_power_kwh", "Total Power Consumption", "kWh", "total_power_consumption_kwh", "power_kwh", "energy_kwh", minimum=0),
    # 14  Charging Status (0/1)
    _i("charging_status", "Charging Status", "0/1", "charge_status", "is_charging", minimum=0, maximum=1),
    # 15  Battery Average Temperature (degC)
    _f("battery_avg_temp_c", "Battery Average Temperature", "degC", "avg_temp", "batt_avg_temp", "battery_average_temp", minimum=-40, maximum=150),
    # 16  Battery Total Voltage (V)
    _f("battery_total_v", "Battery Total Voltage", "V", "total_v", "pack_v", "batt_total_v", "battery_voltage", minimum=0, maximum=1500),
    # 17  Battery Current (A)  -- can be negative (regen/discharge convention)
    _f("battery_current_a", "Battery Current", "A", "current_a", "batt_current", "pack_current_a", minimum=-3000, maximum=3000),
    # 18  Maximum Cell Voltage Cell Number
    _i("max_cell_v_cell_no", "Max Cell Voltage Cell Number", "", "max_cell_v_cell_number", "max_v_cell_no", minimum=0, maximum=4096),
    # 19  Minimum Cell Voltage Battery Number
    _i("min_cell_v_pack_no", "Min Cell Voltage Battery Number", "", "min_cell_v_battery_number", "min_v_pack_no", minimum=0, maximum=64),
    # 20  Minimum Cell Voltage Cell Number
    _i("min_cell_v_cell_no", "Min Cell Voltage Cell Number", "", "min_cell_v_cell_number", "min_v_cell_no", minimum=0, maximum=4096),
    # 21  Maximum Temperature Battery Number
    _i("max_temp_pack_no", "Max Temperature Battery Number", "", "max_temp_battery_number", "max_t_pack_no", minimum=0, maximum=64),
    # 22  Vehicle Work Status  -- upstream type unknown, stored verbatim as text
    ParamSpec(
        name="work_status",
        label="Vehicle Work Status",
        unit="",
        kind="str",
        aliases=("work_status", "vehicle_work_status", "veh_work_status", "workstate"),
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

# keys whose presence/absence the guide actually documents
META_FIELDS: Final[tuple[str, ...]] = ("last_updated",)

MONOTONIC_NAMES: Final[tuple[str, ...]] = tuple(p.name for p in PARAM_SPECS if p.monotonic)

# Every field the Pydantic model will emit (24 params + vehicle timestamp).
COLUMN_NAMES: Final[tuple[str, ...]] = tuple(p.name for p in PARAM_SPECS)


def spec(name: str) -> ParamSpec:
    return SPEC_BY_NAME[name]
