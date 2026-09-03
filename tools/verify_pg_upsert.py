"""Ad-hoc verification of the PostgreSQL upsert path (kept for reference).

Run with:  TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5432/twin \
               python tools/verify_pg_upsert.py
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

from telemetry.config import Settings
from telemetry.db import build_engine, build_session_factory
from telemetry.models import Base
from telemetry.repository import TelemetryRepository
from telemetry.schemas import VehiclesPayload, parse_payload

DATABASE_URL = os.getenv("TEST_DATABASE_URL", "postgresql+psycopg://postgres:postgres@127.0.0.1:5432/twin")

FRAME = {
    "last_updated": "2026-08-27 10:14:52",
    "soc": 78, "soh": 96.5, "odo": 41230, "residual_mileage": 114, "cycles": 312,
    "batt_temp": 34, "min_cell_v": 3.31, "max_cell_v": 3.36, "speed": 0, "regen_kwh": 12.4,
    "latitude": 18.7, "longitude": 80.1, "charging_status": 1, "total_power_kwh": "55.2",
    "work_status": "running", "battery_total_v": 512.4, "max_temp_c": 38, "min_temp_c": 31,
}


def main() -> None:
    settings = Settings(database_url=DATABASE_URL, api_secret_key="x", api_passcode="y")
    engine = build_engine(settings)
    Base.metadata.create_all(engine)
    factory = build_session_factory(engine)
    now = datetime.now(timezone.utc)

    parsed = parse_payload(VehiclesPayload(ok=True, vehicles={"AP39WG5383": FRAME}), settings.tz, ingest_time=now)
    print("accepted:", parsed.accepted, "rejected:", len(parsed.rejected), "missing:", len(parsed.ok[0].missing))
    v = parsed.ok[0]
    print("observed_at:", v.observed_at, "| soc:", v.values["soc"], "| cycles:", v.values["charge_cycles"],
          "| total_power_kwh:", v.values["total_power_kwh"])

    with factory() as s:
        print("write1:", TelemetryRepository(s).write_cycle(parsed.ok, ingested_at=now).as_log())
        s.commit()

    newer = dict(FRAME, last_updated="2026-08-27 10:15:52", soc=75, odo=41235, cycles=313)
    p2 = parse_payload(VehiclesPayload(ok=True, vehicles={"AP39WG5383": newer}), settings.tz, ingest_time=now)
    with factory() as s:
        print("write2 (newer):", TelemetryRepository(s).write_cycle(p2.ok, ingested_at=now).as_log())
        s.commit()
        st = TelemetryRepository(s).snapshot("AP39WG5383")
        print("  -> soc:", st.soc, "odo:", st.odometer_km, "cycles:", st.charge_cycles)
        assert st.soc == 75 and st.odometer_km == 41235 and st.charge_cycles == 313

    older = dict(FRAME, last_updated="2026-08-27 10:10:00", soc=99, odo=41000, cycles=300)
    p3 = parse_payload(VehiclesPayload(ok=True, vehicles={"AP39WG5383": older}), settings.tz, ingest_time=now)
    with factory() as s:
        repo = TelemetryRepository(s)
        print("write3 (stale):", repo.write_cycle(p3.ok, ingested_at=now).as_log())
        s.commit()
        st = repo.snapshot("AP39WG5383")
        print("  -> soc after stale frame:", st.soc, "(expect 75)")
        assert st.soc == 75, "stale frame overwrote newer snapshot!"
        rows = repo.latest_history("AP39WG5383", 10)
        print("  -> history rows:", len(rows), [r.observed_at.isoformat() for r in rows])
        assert len(rows) == 3

    print("PG UPSERT OK")


if __name__ == "__main__":
    main()
