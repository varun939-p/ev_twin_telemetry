#!/usr/bin/env bash
# End-to-end smoke test against the mock upstream + a real PostgreSQL.
#   bash tools/smoke_test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8899}"
export API_SECRET_KEY="sk_mock_9f8e7d6c5b4a"
export API_PASSCODE="MockPasscode123"
export DATABASE_URL="${DATABASE_URL:-postgresql+psycopg://postgres:postgres@127.0.0.1:5432/twin}"
export POLL_INTERVAL_SECONDS=3
export BACKOFF_BASE_SECONDS=0.05
export BACKOFF_MAX_SECONDS=0.2
export LOG_LEVEL=INFO

PY="${PYTHON:-python}"
export PYTHONPATH=.

echo "== 1. start mock upstream =="
$PY -m telemetry mock-server --port 8899 --vehicles 6 --all-fields >/tmp/mock.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 1.5

echo "== 2. init-db =="
$PY -m telemetry init-db

echo "== 3. single cycle (dry run) =="
$PY -m telemetry once --dry-run | head -30

echo "== 4. two real cycles =="
API_BASE_URL="$API_BASE_URL" timeout 12 $PY -m telemetry run || true

echo "== 5. what landed in PostgreSQL =="
$PY - <<'PY'
import os
from sqlalchemy import create_engine, text
eng = create_engine(os.environ["DATABASE_URL"])
with eng.connect() as c:
    for q in [
        "SELECT count(*) FROM vehicles",
        "SELECT count(*) FROM vehicle_state",
        "SELECT count(*) FROM telemetry",
        "SELECT vehicle_id, soc, soh, charge_cycles, charging_status, work_status, last_updated FROM vehicle_state ORDER BY vehicle_id LIMIT 3",
    ]:
        print(f"\n-- {q}")
        for row in c.execute(text(q)):
            print("  ", row)
PY

echo
echo "SMOKE TEST PASSED"
