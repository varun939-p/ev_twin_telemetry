"""End-to-end pre-flight for the serverless deployment shape.

    python tools/serverless_check.py

Exercises the adapter/request contract in one process (not the Vercel gateway):

    next.js rewrite (/api/:path* -> /api/index.py?__telemetry_path=:path*)
        -> path normalizer (api/index.py)
        -> FastAPI control plane (telemetry/main.py)
        -> mock upstream (tools/mock_server.py -- the vendor stand-in)
        -> PostgreSQL upsert (Neon in production; a local server here)
        -> trusted document rebuilt from vehicle_state

Defaults to its own scratch SQLite file. SERVERLESS_CHECK_DATABASE_URL can
select a DISPOSABLE PostgreSQL database instead; never point it at production.
Exit 0 validates the in-process flow, not deployed routing, credentials or cron.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools.mock_server import make_server  # noqa: E402

PASS = "  ok  "
FAIL = " FAIL "
failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"{PASS if condition else FAIL} {name}" + (f" -- {detail}" if detail else ""))
    if not condition:
        failures.append(name)


def main() -> int:
    # ---------------------------------------------------------------- upstream
    upstream = make_server(port=0, vehicles=8, all_fields=True)
    port = upstream.server_address[1]
    threading.Thread(target=upstream.serve_forever, daemon=True).start()

    # ------------------------------------------------------------------- store
    # A scratch database of our own: the pre-flight asserts on absolute row
    # counts, so sharing a database with anything else would be a lie.
    database_url = os.getenv("SERVERLESS_CHECK_DATABASE_URL", "")
    if not database_url:
        fallback = ROOT / ".serverless_check.db"
        if fallback.exists():
            fallback.unlink()
        database_url = f"sqlite:///{fallback}"
        print(f"(scratch store: {fallback.name})")

    os.environ["API_BASE_URL"] = f"http://127.0.0.1:{port}"
    os.environ["API_SECRET_KEY"] = "sk_mock_9f8e7d6c5b4a"
    os.environ["API_PASSCODE"] = "MockPasscode123"
    os.environ["DATABASE_URL"] = database_url
    os.environ["CRON_SECRET"] = "preflight-secret"
    os.environ["INGEST_MIN_INTERVAL_SECONDS"] = "0"
    os.environ.pop("VERCEL", None)

    # Fresh Settings for this process (get_settings is lru_cached).
    from telemetry.config import get_settings

    get_settings.cache_clear()

    # The wrapped app from api/index.py: same ASGI surface Vercel mounts, so
    # the destination-path normalization is exercised for real.
    from api.index import app as wrapped
    from fastapi.testclient import TestClient

    client = TestClient(wrapped)
    auth = {"Authorization": "Bearer preflight-secret"}

    # 1. liveness through the rewritten path
    r = client.get("/api/index.py?__telemetry_path=health")
    check("health via /api/index.py rewrite", r.status_code == 200 and r.json()["status"] == "ok", str(r.status_code))
    check("health reports the database up", r.json().get("database") == "up", r.json().get("database", "?"))

    # 2. the document BEFORE any ingestion: valid, empty, honest
    r = client.get("/api/index.py?__telemetry_path=telemetry/trusted")
    check("empty document is a 200", r.status_code == 200, str(r.status_code))
    check("empty document carries zero vehicles", r.json().get("vehicles") == [])

    # 3. one ingestion cycle: vendor API -> validate -> upsert
    r = client.post("/api/index.py?__telemetry_path=ingest/run", headers=auth)
    ok = r.status_code == 200
    check("cron-style ingestion cycle", ok, r.text[:160] if not ok else "")
    if ok:
        summary = r.json()["summary"]
        check("cycle accepted the fleet", summary["accepted"] == 8, str(summary))
        check("cycle wrote 8 snapshots", summary["states_written"] == 8, str(summary["states_written"]))

    # 4. the dashboard read, now populated
    r = client.get("/api/index.py?__telemetry_path=telemetry/trusted")
    check("trusted document after ingestion", r.status_code == 200, str(r.status_code))
    doc = r.json()
    check("document holds 8 vehicles", len(doc.get("vehicles", [])) == 8, str(len(doc.get("vehicles", []))))
    measured = {name for v in doc["vehicles"] for name, s in v["field_status"].items() if s == "measured"}
    check("all 24 parameters measured (two-tier mock)", len(measured) == 24, f"{len(measured)}/24")
    check(
        "provenance says database-written",
        doc["provenance"]["input_shape"] == "postgres_snapshot",
        doc["provenance"]["input_shape"],
    )
    check(
        "the old snapshot file is not involved",
        "trusted_vehicle_telemetry" not in r.text,
    )

    # 5. auth: a wrong bearer must not pass
    r = client.get("/api/index.py?__telemetry_path=cron/ingest", headers={"Authorization": "Bearer nope"})
    check("wrong bearer rejected", r.status_code == 401, str(r.status_code))

    # 6. idempotence: a second cycle keeps one row per vehicle
    r = client.post("/api/index.py?__telemetry_path=ingest/run", headers=auth)
    check("second cycle also succeeds", r.status_code == 200, str(r.status_code))

    upstream.shutdown()
    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("all checks passed -- in-process adapter, ingestion and DB flow (deployment not verified)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
