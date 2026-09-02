"""SQLAlchemy 2.0 (typed, `Mapped[]`) models for the telemetry store.

Table split
-----------
    vehicles         dimension -- one row per truck ever seen
    vehicle_state    1:1 snapshot, the dashboard's hot path (upserted in place)
    telemetry        append-only history, one row per (vehicle, observed_at)

Keeping the snapshot out of the history table is what lets the dashboard read
`SELECT * FROM vehicle_state` instead of running a `DISTINCT ON` over millions
of history rows on every page load.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Index,
    JSON,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import DOUBLE_PRECISION, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# JSONB on PostgreSQL; generic JSON elsewhere so dev/CI on SQLite still works.
_JSON = JSON().with_variant(JSONB(), "postgresql")

from .fields import SPEC_BY_NAME


class Base(DeclarativeBase):
    pass


def _numeric_column(name: str):
    """Map a registry entry to the cheapest type that is still exact."""
    spec = SPEC_BY_NAME[name]
    if spec.kind == "int":
        if spec.maximum is not None and spec.maximum <= 32767:
            # 0/1 flags and cell/battery numbers: SMALLINT is plenty
            return mapped_column(SmallInteger, nullable=True)
        # counters (charge_cycles) and odometer-like values: BIGINT, no surprises
        return mapped_column(BigInteger, nullable=True)
    if spec.kind == "str":
        return mapped_column(String(64), nullable=True)
    # NUMERIC(10,3) for anything the API sends with <= 3 decimals, else DOUBLE.
    # Voltage/temperature/percentage readings are decimal, so NUMERIC keeps them
    # exact; lat/long and energy totals get DOUBLE.
    if name in {"latitude", "longitude", "regen_kwh", "total_power_kwh", "odometer_km", "residual_mileage_km", "speed_kmh"}:
        return mapped_column(DOUBLE_PRECISION, nullable=True)
    return mapped_column(Numeric(10, 3), nullable=True)


class Vehicle(Base):
    """Fleet dimension. One row per vehicle id ever observed."""

    __tablename__ = "vehicles"
    __table_args__ = (Index("ix_vehicles_last_seen", "last_seen"), {"comment": "Fleet dimension table"})

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    vehicle_id: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    ingest_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class VehicleState(Base):
    """Latest-known snapshot per vehicle -- the table the dashboard reads."""

    __tablename__ = "vehicle_state"
    __table_args__ = (
        # The hot dashboard query: "who is charging right now?"
        Index("ix_vehicle_state_charging", "charging_status", postgresql_where="charging_status = 1"),
        # Health board: worst SOH first.
        Index("ix_vehicle_state_soh", "soh"),
        # Low-SOC alert sweep.
        Index("ix_vehicle_state_soc", "soc"),
        # Fleet-wide freshness / staleness sweep by source timestamp.
        Index("ix_vehicle_state_last_updated", "last_updated"),
        {"comment": "Latest telemetry snapshot per vehicle (upserted)"},
    )

    # Natural PK: the upsert conflict target is `vehicle_id` alone, and the
    # 1:1 guarantee comes from the constraint itself rather than app logic.
    vehicle_id: Mapped[str] = mapped_column(String(32), primary_key=True)

    # ---- the 24 parameters -------------------------------------------------
    soc: Mapped[float | None] = _numeric_column("soc")
    soh: Mapped[float | None] = _numeric_column("soh")
    odometer_km: Mapped[float | None] = _numeric_column("odometer_km")
    residual_mileage_km: Mapped[float | None] = _numeric_column("residual_mileage_km")
    charge_cycles: Mapped[int | None] = _numeric_column("charge_cycles")
    battery_temp_c: Mapped[float | None] = _numeric_column("battery_temp_c")
    min_cell_v: Mapped[float | None] = _numeric_column("min_cell_v")
    max_cell_v: Mapped[float | None] = _numeric_column("max_cell_v")
    max_temp_c: Mapped[float | None] = _numeric_column("max_temp_c")
    min_temp_c: Mapped[float | None] = _numeric_column("min_temp_c")
    regen_kwh: Mapped[float | None] = _numeric_column("regen_kwh")
    speed_kmh: Mapped[float | None] = _numeric_column("speed_kmh")
    total_power_kwh: Mapped[float | None] = _numeric_column("total_power_kwh")
    charging_status: Mapped[int | None] = _numeric_column("charging_status")
    battery_avg_temp_c: Mapped[float | None] = _numeric_column("battery_avg_temp_c")
    battery_total_v: Mapped[float | None] = _numeric_column("battery_total_v")
    battery_current_a: Mapped[float | None] = _numeric_column("battery_current_a")
    max_cell_v_cell_no: Mapped[int | None] = _numeric_column("max_cell_v_cell_no")
    min_cell_v_pack_no: Mapped[int | None] = _numeric_column("min_cell_v_pack_no")
    min_cell_v_cell_no: Mapped[int | None] = _numeric_column("min_cell_v_cell_no")
    max_temp_pack_no: Mapped[int | None] = _numeric_column("max_temp_pack_no")
    work_status: Mapped[str | None] = _numeric_column("work_status")
    latitude: Mapped[float | None] = _numeric_column("latitude")
    longitude: Mapped[float | None] = _numeric_column("longitude")

    # ---- bookkeeping -------------------------------------------------------
    # `last_updated` = source-side timestamp of this frame (what the API calls it)
    last_updated: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # `ingested_at`  = when our engine wrote it
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    raw_frame: Mapped[dict | None] = mapped_column(_JSON, nullable=True)


class Telemetry(Base):
    """Append-only history. One row per (vehicle_id, observed_at)."""

    __tablename__ = "telemetry"
    __table_args__ = (
        # Dedupe key AND the upsert conflict target. Also serves
        # "give me vehicle X, newest first" without a sort.
        # Doubles as the index for "vehicle X, newest first" -- a separate
        # (vehicle_id, observed_at) index would be an exact duplicate of the
        # btree Postgres builds for this constraint, so we do not create one.
        UniqueConstraint("vehicle_id", "observed_at", name="uq_telemetry_vehicle_observed"),
        # Retention sweeps / cross-fleet time-range scans.
        Index("ix_telemetry_observed_at", "observed_at"),
        {"comment": "Immutable telemetry history, one row per vehicle reading"},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    vehicle_id: Mapped[str] = mapped_column(String(32), nullable=False, index=False)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    soc: Mapped[float | None] = _numeric_column("soc")
    soh: Mapped[float | None] = _numeric_column("soh")
    odometer_km: Mapped[float | None] = _numeric_column("odometer_km")
    residual_mileage_km: Mapped[float | None] = _numeric_column("residual_mileage_km")
    charge_cycles: Mapped[int | None] = _numeric_column("charge_cycles")
    battery_temp_c: Mapped[float | None] = _numeric_column("battery_temp_c")
    min_cell_v: Mapped[float | None] = _numeric_column("min_cell_v")
    max_cell_v: Mapped[float | None] = _numeric_column("max_cell_v")
    max_temp_c: Mapped[float | None] = _numeric_column("max_temp_c")
    min_temp_c: Mapped[float | None] = _numeric_column("min_temp_c")
    regen_kwh: Mapped[float | None] = _numeric_column("regen_kwh")
    speed_kmh: Mapped[float | None] = _numeric_column("speed_kmh")
    total_power_kwh: Mapped[float | None] = _numeric_column("total_power_kwh")
    charging_status: Mapped[int | None] = _numeric_column("charging_status")
    battery_avg_temp_c: Mapped[float | None] = _numeric_column("battery_avg_temp_c")
    battery_total_v: Mapped[float | None] = _numeric_column("battery_total_v")
    battery_current_a: Mapped[float | None] = _numeric_column("battery_current_a")
    max_cell_v_cell_no: Mapped[int | None] = _numeric_column("max_cell_v_cell_no")
    min_cell_v_pack_no: Mapped[int | None] = _numeric_column("min_cell_v_pack_no")
    min_cell_v_cell_no: Mapped[int | None] = _numeric_column("min_cell_v_cell_no")
    max_temp_pack_no: Mapped[int | None] = _numeric_column("max_temp_pack_no")
    work_status: Mapped[str | None] = _numeric_column("work_status")
    latitude: Mapped[float | None] = _numeric_column("latitude")
    longitude: Mapped[float | None] = _numeric_column("longitude")

    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
