"""The PostgreSQL write path: upserts, anti-regression, idempotency.

These run against real PostgreSQL when TEST_DATABASE_URL is set, because the
upsert is dialect-specific SQL -- a SQLite approximation would prove nothing
about the statement that actually ships.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from telemetry.config import Settings
from telemetry.models import Telemetry, Vehicle, VehicleState
from telemetry.repository import TelemetryRepository
from telemetry.schemas import DashboardPayload, parse_payload

BASE_FRAME = {
    "last_updated": "2026-08-27 10:00:00",
    "soc": 80, "soh": 97.0, "odo": 41000, "residual_mileage": 120, "cycles": 300,
    "batt_temp": 32, "min_cell_v": 3.31, "max_cell_v": 3.36, "speed": 0,
    "regen_kwh": 10.0, "max_temp_c": 36, "min_temp_c": 28, "total_power_kwh": 1500,
    "charging_status": 0, "battery_avg_temp_c": 32, "battery_total_v": 520,
    "battery_current_a": 0, "max_cell_v_cell_no": 12, "min_cell_v_pack_no": 2,
    "min_cell_v_cell_no": 88, "max_temp_pack_no": 1, "work_status": "PARKED",
    "latitude": 14.5, "longitude": 80.1,
}

IST_NOW = datetime(2026, 8, 27, 4, 30, tzinfo=timezone.utc)  # 10:00 IST == 04:30 UTC


def settings() -> Settings:
    return Settings(api_base_url="http://x", api_secret_key="k", api_passcode="p",
                    database_url="sqlite://", _env_file=None)


def frames(*pairs) -> list:
    """[(vehicle_id, frame), ...] -> validated ParsedVehicle list."""
    payload = DashboardPayload(ok=True, vehicles={vid: frame for vid, frame in pairs})
    return parse_payload(payload, settings().tz, ingest_time=IST_NOW).ok


def write(session, vehicles, *, ingested_at=IST_NOW, unchanged=()) -> object:
    result = TelemetryRepository(session).write_cycle(
        vehicles, ingested_at=ingested_at, unchanged_ids=unchanged
    )
    session.commit()
    return result


# ------------------------------------------------------------------- basics
def test_first_write_creates_all_three_tables(pg_session):
    result = write(pg_session, frames(("AP39WG5383", BASE_FRAME)))

    assert result.vehicles == 1
    assert result.states_written == 1
    assert result.history_written == 1

    assert pg_session.scalar(select(func.count()).select_from(Vehicle)) == 1
    assert pg_session.scalar(select(func.count()).select_from(VehicleState)) == 1
    assert pg_session.scalar(select(func.count()).select_from(Telemetry)) == 1


def test_all_24_columns_are_persisted(pg_session):
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)))
    state = pg_session.get(VehicleState, "AP39WG5383")

    assert float(state.soc) == 80
    assert float(state.soh) == 97.0
    assert state.odometer_km == 41000
    assert state.residual_mileage_km == 120
    assert state.charge_cycles == 300
    assert float(state.battery_temp_c) == 32
    assert float(state.min_cell_v) == 3.31
    assert float(state.max_cell_v) == 3.36
    assert float(state.max_temp_c) == 36
    assert float(state.min_temp_c) == 28
    assert state.regen_kwh == 10.0
    assert state.speed_kmh == 0
    assert state.total_power_kwh == 1500
    assert state.charging_status == 0
    assert float(state.battery_avg_temp_c) == 32
    assert float(state.battery_total_v) == 520
    assert float(state.battery_current_a) == 0
    assert state.max_cell_v_cell_no == 12
    assert state.min_cell_v_pack_no == 2
    assert state.min_cell_v_cell_no == 88
    assert state.max_temp_pack_no == 1
    assert state.work_status == "PARKED"
    assert state.latitude == 14.5
    assert state.longitude == 80.1
    assert state.last_updated == IST_NOW


def test_timestamps_are_stored_utc_aware(pg_session):
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)))
    state = pg_session.get(VehicleState, "AP39WG5383")
    assert state.last_updated.tzinfo is not None
    assert state.last_updated == IST_NOW


def test_repeat_write_updates_in_place_and_appends_history(pg_session):
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)))
    newer = dict(BASE_FRAME, last_updated="2026-08-27 10:01:00", soc=77)
    write(pg_session, frames(("AP39WG5383", newer)), ingested_at=IST_NOW + timedelta(minutes=1))

    assert pg_session.scalar(select(func.count()).select_from(VehicleState)) == 1
    assert pg_session.scalar(select(func.count()).select_from(Telemetry)) == 2
    assert float(pg_session.get(VehicleState, "AP39WG5383").soc) == 77


def test_fleet_of_many_vehicles_is_one_transaction(pg_session):
    pairs = [(f"AP39W{i:05d}", dict(BASE_FRAME, soc=50 + i)) for i in range(25)]
    result = write(pg_session, frames(*pairs))
    assert result.vehicles == 25
    assert result.states_written == 25
    assert result.history_written == 25
    assert pg_session.scalar(select(func.count()).select_from(Telemetry)) == 25


# ------------------------------------------------------- anti-regression
def test_stale_frame_cannot_regress_the_snapshot(pg_session):
    """Out-of-order delivery is normal in telemetry; the snapshot must be monotonic."""
    write(pg_session, frames(("AP39WG5383", dict(BASE_FRAME, last_updated="2026-08-27 10:05:00", soc=70))))
    stale = dict(BASE_FRAME, last_updated="2026-08-27 09:55:00", soc=99, odo=1, cycles=1)
    result = write(pg_session, frames(("AP39WG5383", stale)))

    state = pg_session.get(VehicleState, "AP39WG5383")
    assert float(state.soc) == 70, "an older frame overwrote a newer snapshot"
    assert state.odometer_km == 41000
    assert result.states_skipped_stale == 1
    # ...but the reading is still archived, it is real data
    assert result.history_written == 1


def test_monotonic_counters_cannot_go_backwards_even_with_a_newer_timestamp(pg_session):
    """A rolled-back ECU counter must not lower the odometer we show."""
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)))  # odo 41000, cycles 300
    bad = dict(BASE_FRAME, last_updated="2026-08-27 10:10:00", odo=39000, cycles=250, soc=65)
    result = write(pg_session, frames(("AP39WG5383", bad)))

    state = pg_session.get(VehicleState, "AP39WG5383")
    assert state.odometer_km == 41000
    assert state.charge_cycles == 300
    assert result.states_skipped_stale == 1


def test_history_dedupes_on_vehicle_and_timestamp(pg_session):
    """Replaying the same frame twice must not create a duplicate history row."""
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)))
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)))
    assert pg_session.scalar(select(func.count()).select_from(Telemetry)) == 1


# -------------------------------------------------------------- optimisation
def test_unchanged_vehicles_skip_writes_but_refresh_last_seen(pg_session):
    first = IST_NOW
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)), ingested_at=first)

    later = first + timedelta(minutes=5)
    parsed = frames(("AP39WG5383", BASE_FRAME))
    result = write(pg_session, parsed, ingested_at=later, unchanged=["AP39WG5383"])

    assert result.skipped_unchanged == 1
    assert result.states_written == 0
    assert result.history_written == 1 - 1  # nothing new archived
    assert pg_session.scalar(select(func.count()).select_from(Telemetry)) == 1
    assert pg_session.get(Vehicle, pg_session.scalar(select(Vehicle.id))).last_seen == later
    assert pg_session.scalar(select(Vehicle.ingest_count)) == 2


def test_partial_payload_stores_nulls_without_touching_other_columns(pg_session):
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)))
    # A field-restricted client suddenly sends only soc
    partial = {"last_updated": "2026-08-27 10:02:00", "soc": 74}
    write(pg_session, frames(("AP39WG5383", partial)), ingested_at=IST_NOW + timedelta(minutes=2))

    state = pg_session.get(VehicleState, "AP39WG5383")
    assert float(state.soc) == 74
    assert state.work_status is None, "the upsert writes the whole frame, by design"
    assert state.charge_cycles is None


# ------------------------------------------------------------------- queries
def test_stale_vehicles_query(pg_session):
    write(pg_session, frames(("AP39WG5383", BASE_FRAME)))
    repo = TelemetryRepository(pg_session)
    assert repo.stale_vehicles(IST_NOW + timedelta(minutes=1)) == ["AP39WG5383"]
    assert repo.stale_vehicles(IST_NOW - timedelta(minutes=1)) == []


def test_latest_history_is_ordered_newest_first(pg_session):
    for offset in range(5):
        frame = dict(BASE_FRAME, last_updated=f"2026-08-27 10:0{offset}:00", soc=50 + offset)
        write(
            pg_session,
            frames(("AP39WG5383", frame)),
            ingested_at=IST_NOW + timedelta(minutes=offset),
        )
    repo = TelemetryRepository(pg_session)
    rows = repo.latest_history("AP39WG5383", limit=3)
    assert [float(r.soc) for r in rows] == [54.0, 53.0, 52.0]


def test_dashboard_query_uses_the_snapshot_table(pg_session):
    """The query the frontend will actually run."""
    pairs = [(f"AP39W{i:05d}", dict(BASE_FRAME, soc=50 + i, charging_status=i % 2)) for i in range(6)]
    write(pg_session, frames(*pairs))

    charging = pg_session.scalars(
        select(VehicleState.vehicle_id, VehicleState.soc).where(VehicleState.charging_status == 1)
    ).all()
    assert len(charging) == 3


def test_write_with_no_vehicles_is_a_no_op(pg_session):
    result = write(pg_session, [])
    assert result.vehicles == 0
    assert pg_session.scalar(select(func.count()).select_from(Telemetry)) == 0


def test_frame_without_timestamp_is_archived_under_ingest_time(pg_session):
    frame = {k: v for k, v in BASE_FRAME.items() if k != "last_updated"}
    parsed = parse_payload(
        DashboardPayload(ok=True, vehicles={"AP39WG5383": frame}),
        settings().tz,
        ingest_time=IST_NOW,
        fallback_observed_at="ingest",
    ).ok
    result = write(pg_session, parsed)
    assert result.history_written == 1
    assert pg_session.get(Telemetry, pg_session.scalar(select(Telemetry.id))).observed_at == IST_NOW
