# EV Battery Swap Station Digital Twin — Telemetry Extraction Engine

Pulls fleet telemetry from the Dashboard Parameters API into PostgreSQL, where
the frontend dashboard reads it.

```
GET /api/dashboard-parameters  ──►  Pydantic validation  ──►  PostgreSQL upsert
        (Bearer token,                 (24 parameters,         vehicles
         59-min lifetime,               quarantine on            vehicle_state  ◄── dashboard reads this
         no refresh endpoint)            bad data)               telemetry      ◄── history / trends
```

**Read `docs/ARCHITECTURE.md` first** — it covers the schema design, the
indexing rationale and the token-rotation strategy. This README is just how to
run it.

---

## ⚠️ Before you go live: 14 of the 24 field names are guesses

`DASHBOARD_API_GUIDE.md` documents the wire keys for **10 of your 24
parameters** (`soc`, `soh`, `odo`, `residual_mileage`, `cycles`, `batt_temp`,
`min_cell_v`, `max_cell_v`, `speed`, `regen_kwh`) plus `last_updated`.

The other 14 — max/min temperature, total power, charging status, battery
voltage/current, the four cell/battery numbers, work status, lat/long — use
**inferred** key names with three or four aliases each. Nothing breaks if a guess
is wrong (missing keys become `NULL` and are logged loudly), but the columns will
be empty.

Close the gap with one command against the real API:

```bash
python -m telemetry once --dry-run     # prints accepted values + the `missing` list per vehicle
python -m telemetry fields             # prints the full mapping table
```

Then add the real keys to the `aliases` tuples in `telemetry/fields.py` — one
line per parameter, and the model, ORM and upsert all pick it up automatically.
See `docs/ARCHITECTURE.md` §7.

---

## Quick start

```bash
# 1. dependencies
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 2. configuration
cp .env.example .env
#    fill in API_BASE_URL, API_SECRET_KEY, API_PASSCODE, DATABASE_URL

# 3. schema
python -m telemetry init-db

# 4. run
python -m telemetry run
```

Or with make: `make setup && make initdb && make run`.

### Try it with zero credentials

A faithful stand-in for the upstream API ships with the project, so you can see
the whole pipeline working before you have production access:

```bash
make mock                                  # terminal 1 — mock upstream on :8899
export API_BASE_URL=http://127.0.0.1:8899
export API_SECRET_KEY=sk_mock_9f8e7d6c5b4a
export API_PASSCODE=MockPasscode123
export DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5432/twin
python -m telemetry run                    # terminal 2
```

Or the whole thing at once: `make smoke` (mock upstream → engine → PostgreSQL,
with row counts at the end).

### Docker

```bash
cp .env.example .env                       # API_* values can stay as the mock's
docker compose up -d db
docker compose run --rm extractor init-db
docker compose up extractor                # runs against the bundled mock upstream
curl -s localhost:9464/metrics | head      # if METRICS_ENABLED=true
```

---

## Commands

| Command | Purpose |
|---|---|
| `python -m telemetry run` | the continuous extraction loop |
| `python -m telemetry init-db` | create tables and indexes |
| `python -m telemetry schema` | print the PostgreSQL DDL (for an Alembic revision) |
| `python -m telemetry once` | one cycle, then exit |
| `python -m telemetry once --dry-run` | fetch + validate, print JSON, write nothing |
| `python -m telemetry fields` | print the 24-parameter mapping table |
| `python -m telemetry mock-server` | local stand-in for the upstream API |

---

## Configuration

Everything is environment-driven (`.env` is read automatically). Full annotated
list in `.env.example`. The important ones:

| Variable | Default | Notes |
|---|---|---|
| `API_BASE_URL` | — | **required**, no trailing slash |
| `API_SECRET_KEY` / `API_PASSCODE` | — | **required**; shown once by the admin endpoint |
| `DATABASE_URL` | — | **required**; `postgresql+psycopg://…` (psycopg **3**) |
| `POLL_INTERVAL_SECONDS` | `60` | |
| `TOKEN_REFRESH_INTERVAL` | `3300` | 55 min; the server's token lives 3540 s |
| `TOKEN_EXPIRY_SAFETY_MARGIN` | `240` | headroom kept before expiry |
| `HTTP_MAX_RETRIES` | `5` | 5xx / timeouts only — never 400/401/403/404 |
| `BACKOFF_BASE_SECONDS` / `BACKOFF_MAX_SECONDS` | `1` / `60` | exponential, full jitter |
| `REQUIRE_ALL_FIELDS` | `false` | `true` rejects frames missing any of the 24 |
| `WRITE_UNCHANGED` | `false` | `true` archives a row even when nothing changed |
| `SOURCE_TIMEZONE` | `Asia/Kolkata` | the API's naive `last_updated` is IST |
| `METRICS_ENABLED` / `METRICS_PORT` | `false` / `9464` | Prometheus text endpoint |

**Never commit `.env`** — the passcode is not recoverable once lost.

---

## The database

| Table | Grain | Read it for |
|---|---|---|
| `vehicles` | one row per vehicle | fleet dimension: first/last seen, ingest count |
| `vehicle_state` | one row per vehicle | **the dashboard**: current SOC, SOH, charging, position |
| `telemetry` | one row per (vehicle, reading) | history: trends, SOH curves, audits |

```sql
-- what the dashboard shows
SELECT vehicle_id, soc, soh, charging_status, work_status, last_updated
FROM vehicle_state ORDER BY soc;

-- who is charging right now  (partial index on charging_status = 1)
SELECT vehicle_id, soc FROM vehicle_state WHERE charging_status = 1;

-- which trucks stopped reporting
SELECT vehicle_id, last_updated FROM vehicle_state
WHERE last_updated < now() - interval '10 minutes';

-- SOC trend for one truck  (unique index on vehicle_id, observed_at)
SELECT observed_at, soc FROM telemetry
WHERE vehicle_id = 'AP39WG5383' ORDER BY observed_at DESC LIMIT 100;
```

DDL: `deploy/schema.sql` (generated by `python -m telemetry schema`, and verified
to execute cleanly on PostgreSQL 17).

Timestamps are stored **UTC-aware**. The API's naive `last_updated` is IST, and
is converted on the way in — see `docs/ARCHITECTURE.md` §5.

---

## Tests

```bash
# no PostgreSQL needed: 66 pass, the 28 database-backed ones skip
pytest

# everything, including the PostgreSQL upsert tests: 94 pass
export TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5432/twin
pytest

# just the database-independent tests (validation, rotation, retry)
pytest -k "not repository and not e2e"
```

The PostgreSQL tests *skip* rather than fail without `TEST_DATABASE_URL`,
because the upsert is dialect-specific SQL and a SQLite approximation would
prove nothing about the statement that ships.

What the suite actually proves:

* **94 tests**, no mocking of the code under test — the retry, auth and loop
  tests drive a real HTTP server and a real PostgreSQL.
* Token rotation at exactly 55 minutes, driven by a fake clock (no sleeping).
* A revoked token mid-run: exactly one re-auth, zero failed cycles, **and the
  retried poll still written**.
* 500s retried with exponential backoff; 400/401/403/404 never retried.
* An out-of-order frame cannot regress the snapshot; a rolled-back odometer
  cannot lower a counter.
* One poisoned field does not cost a vehicle; one bad vehicle does not cost the
  fleet.
* `SIGTERM` finishes the in-flight cycle and exits 0.

---

## Layout

```
telemetry/          the engine (fields → schemas → api/auth → extractor → repository)
tests/              94 tests
tools/              mock upstream server + smoke test
deploy/schema.sql   the DDL
docs/               ARCHITECTURE.md — read this
```

Module-by-module explanation in `docs/ARCHITECTURE.md` §2.
