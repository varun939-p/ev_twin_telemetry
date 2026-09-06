"""Write path. One transaction per poll cycle, three set-based upserts.

Why `INSERT ... ON CONFLICT` and not ORM `merge()`
-------------------------------------------------
A cycle can carry dozens of vehicles; a per-row SELECT-then-INSERT would be 2N
round trips under a lock.  A single multi-VALUES upsert per table is 3
statements total, is idempotent (safe to replay after a crash mid-cycle), and
lets PostgreSQL enforce the "never write an older frame over a newer one" rule
inside the statement, where no concurrent writer can slip in between.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from .fields import COLUMN_NAMES, MONOTONIC_NAMES
from .schemas import ParsedVehicle
from .models import Telemetry, Vehicle, VehicleState

log = logging.getLogger(__name__)


def _same_instant(a: datetime | None, b: datetime | None) -> bool:
    """Timestamp equality that tolerates a database which drops the offset.

    PostgreSQL TIMESTAMPTZ round-trips aware datetimes exactly; SQLite stores
    the naive rendering and hands it back without tzinfo.  Treat naive values
    as UTC -- the engine only ever writes UTC-aware timestamps -- so the
    applied/stale bookkeeping is correct on both dialects.
    """
    if a is None or b is None:
        return a == b
    if a.tzinfo is None:
        a = a.replace(tzinfo=timezone.utc)
    if b.tzinfo is None:
        b = b.replace(tzinfo=timezone.utc)
    return a == b


@dataclass(slots=True)
class WriteResult:
    vehicles: int = 0
    states_written: int = 0
    states_skipped_stale: int = 0
    history_written: int = 0
    skipped_unchanged: int = 0
    errors: list[str] = field(default_factory=list)

    def as_log(self) -> str:
        return (
            f"vehicles={self.vehicles} state={self.states_written} "
            f"history={self.history_written} stale_skipped={self.states_skipped_stale} "
            f"unchanged_skipped={self.skipped_unchanged}"
        )


class TelemetryRepository:
    """All database writes live here. The extractor never builds SQL."""

    def __init__(self, session: Session) -> None:
        self.session = session
        self._insert = pg_insert if session.bind.dialect.name == "postgresql" else sqlite_insert

    # ------------------------------------------------------------------ public
    def write_cycle(
        self,
        vehicles: Sequence[ParsedVehicle],
        *,
        ingested_at: datetime,
        unchanged_ids: Iterable[str] = (),
    ) -> WriteResult:
        """Persist one poll cycle atomically.

        `unchanged_ids` are vehicles whose reading is byte-identical to the last
        one we stored: their dimension `last_seen` is refreshed but no snapshot
        or history row is written (saves ~90% of writes for an idle fleet).
        """
        result = WriteResult()
        if not vehicles:
            return result

        skip = set(unchanged_ids)
        fresh = [v for v in vehicles if v.vehicle_id not in skip]
        result.skipped_unchanged = len(skip)

        self._upsert_dimensions(vehicles, ingested_at)
        result.vehicles = len(vehicles)

        if fresh:
            written, stale = self._upsert_state(fresh, ingested_at)
            result.states_written = written
            result.states_skipped_stale = stale
            result.history_written = self._append_history(fresh, ingested_at)

        return result

    def stale_vehicles(self, older_than: datetime) -> list[str]:
        """Vehicles whose snapshot has not advanced since `older_than`."""
        stmt = select(VehicleState.vehicle_id).where(VehicleState.last_updated < older_than)
        return list(self.session.scalars(stmt))

    def snapshot(self, vehicle_id: str) -> VehicleState | None:
        return self.session.get(VehicleState, vehicle_id)

    def latest_history(self, vehicle_id: str, limit: int = 10) -> list[Telemetry]:
        stmt = (
            select(Telemetry)
            .where(Telemetry.vehicle_id == vehicle_id)
            .order_by(Telemetry.observed_at.desc())
            .limit(limit)
        )
        return list(self.session.scalars(stmt))

    # ----------------------------------------------------------------- private
    def _upsert_dimensions(self, vehicles: Sequence[ParsedVehicle], ingested_at: datetime) -> None:
        rows = [
            {
                "vehicle_id": v.vehicle_id,
                "first_seen": ingested_at,
                "last_seen": ingested_at,
                "ingest_count": 1,
                "is_active": True,
            }
            for v in vehicles
        ]
        stmt = (
            self._insert(Vehicle)
            .values(rows)
            .on_conflict_do_update(
                index_elements=[Vehicle.vehicle_id],
                set_={
                    "last_seen": ingested_at,
                    "is_active": True,
                    "ingest_count": Vehicle.ingest_count + 1,
                },
            )
        )
        self.session.execute(stmt)

    def _upsert_state(self, vehicles: Sequence[ParsedVehicle], ingested_at: datetime) -> tuple[int, int]:
        rows = [self._state_row(v, ingested_at) for v in vehicles]
        stmt = self._insert(VehicleState).values(rows)

        excluded = stmt.excluded
        # Only advance the snapshot when the incoming frame is not older than
        # what we already hold, and monotonic counters do not go backwards.
        # Postgres evaluates this WHERE after locating the conflicting row, so a
        # rejected row is simply left untouched -- the check happens inside the
        # statement, where no concurrent writer can slip between read and write.
        conditions = [
            or_(
                VehicleState.last_updated.is_(None),
                excluded.last_updated.is_(None),
                excluded.last_updated >= VehicleState.last_updated,
            )
        ]
        for name in MONOTONIC_NAMES:
            col = getattr(VehicleState, name)
            conditions.append(
                or_(col.is_(None), excluded[name].is_(None), excluded[name] >= col)
            )

        set_ = {name: excluded[name] for name in COLUMN_NAMES}
        set_ |= {
            "last_updated": excluded.last_updated,
            "ingested_at": excluded.ingested_at,
            "raw_frame": excluded.raw_frame,
            "field_status": excluded.field_status,
            "missing_fields": excluded.missing_fields,
            "field_errors": excluded.field_errors,
        }

        stmt = stmt.on_conflict_do_update(
            index_elements=[VehicleState.vehicle_id],
            set_=set_,
            where=and_(*conditions),
        )
        self.session.execute(stmt)

        # `rowcount` cannot tell us how many rows the WHERE clause rejected:
        # PostgreSQL reports a row as affected for INSERT ... ON CONFLICT even
        # when DO UPDATE's WHERE skips it.  So read the snapshot back -- still
        # inside this transaction -- and compare each stored timestamp with the
        # one we tried to write.
        applied = self._applied_states(rows)
        return len(applied), len(rows) - len(applied)

    def _applied_states(self, rows: list[dict[str, Any]]) -> list[str]:
        """Vehicle ids whose snapshot now carries the timestamp we just wrote."""
        wanted = {r["vehicle_id"]: r["last_updated"] for r in rows}
        stmt = select(VehicleState.vehicle_id, VehicleState.last_updated).where(
            VehicleState.vehicle_id.in_(list(wanted))
        )
        applied: list[str] = []
        for vehicle_id, stored in self.session.execute(stmt):
            if _same_instant(stored, wanted[vehicle_id]):
                applied.append(vehicle_id)
        return applied

    def _append_history(self, vehicles: Sequence[ParsedVehicle], ingested_at: datetime) -> int:
        rows = [
            self._history_row(v, ingested_at)
            for v in vehicles
            if v.observed_at is not None  # observed_at is NOT NULL by design
        ]
        if not rows:
            return 0

        stmt = self._insert(Telemetry).values(rows)
        excluded = stmt.excluded  # must come from THIS statement, else the compiler
        # sees column objects belonging to a different insert ("Unconsumed column names")
        set_ = {name: excluded[name] for name in COLUMN_NAMES}
        set_["ingested_at"] = excluded.ingested_at

        stmt = stmt.on_conflict_do_update(
            index_elements=[Telemetry.vehicle_id, Telemetry.observed_at],
            set_=set_,
        )
        cursor = self.session.execute(stmt)
        return cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else len(rows)

    @staticmethod
    def _state_row(vehicle: ParsedVehicle, ingested_at: datetime) -> dict[str, Any]:
        """Row for `vehicle_state` (timestamp column is `last_updated`)."""
        # Import here (not at module top) to keep the repository independent of
        # the presentation layer in every other code path.
        from .document import statuses_for

        row: dict[str, Any] = {
            "vehicle_id": vehicle.vehicle_id,
            "last_updated": vehicle.observed_at,
            "ingested_at": ingested_at,
            "raw_frame": vehicle.values,
            # The validator's per-parameter verdicts travel with the frame so
            # the dashboard document can be rebuilt from this table later
            # without re-running (or approximating) validation.
            "field_status": statuses_for(vehicle),
            "missing_fields": list(vehicle.missing),
            "field_errors": [err.model_dump() for err in vehicle.field_errors],
        }
        for name in COLUMN_NAMES:
            row[name] = vehicle.values.get(name)
        return row

    @staticmethod
    def _history_row(vehicle: ParsedVehicle, ingested_at: datetime) -> dict[str, Any]:
        """Row for `telemetry` (timestamp column is `observed_at`)."""
        row: dict[str, Any] = {
            "vehicle_id": vehicle.vehicle_id,
            "observed_at": vehicle.observed_at,
            "ingested_at": ingested_at,
        }
        for name in COLUMN_NAMES:
            row[name] = vehicle.values.get(name)
        return row
