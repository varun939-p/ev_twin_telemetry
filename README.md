# EV Battery Swap Station Digital Twin — Telemetry Extraction Engine

Pulls fleet telemetry from the Blue Energy Motors vehicles API
(`GET https://track.blueenergymotors.com/api/v1/vehicles`) into PostgreSQL,
where the frontend dashboard reads it.

```
GET /api/v1/vehicles           ──►  Pydantic validation  ──►  PostgreSQL upsert
        (Bearer token,                 (24 parameters,         vehicles
         59-min lifetime,               quarantine on            vehicle_state  ◄── dashboard reads this
         no refresh endpoint)            bad data)               telemetry      ◄── history / trends
```

**Read `docs/ARCHITECTURE.md` first** — it covers the schema design, the
indexing rationale and the token-rotation strategy. This README is just how to
run it.

---

## Field mapping: all 24 parameters, two tiers

Verified against the live v1 contract (Postman, 2026-09) and a real
100-vehicle pull (`blue_energy_response.json`, 2026-08-28):

* **Tier 1 — `GET /api/v1/vehicles`** returns the fleet summary: operational
  keys (`soc`, `odo`, `speed`, `latitude`, `longitude`, …) and an explicit
  `"battery": null` placeholder per frame.
* **Tier 2 — `GET /api/v1/vehicles/{id}`** returns the complete live
  diagnostic frame, including the battery block under the abbreviated v1 keys
  (`batt_v`, `chg_status`, `batt_temp`, `batt_a`, `tot_power_kwh`,
  `max_cell_no`, `min_pack_no`, `min_cell_no`, `max_t_pack`, `work_sts`).
  The engine fetches it per vehicle, concurrently, and merges it into the
  summary frame (`merge_vehicle_frames`) — detail nulls never erase summary
  readings.

Nothing is pinned NULL any more: a parameter is `NULL` **only** when the
merged tier-1 + tier-2 frame genuinely lacks every alias for it (or carries an
unusable sentinel). The historical 2026-08-28 capture predates the tier-2
battery block, so its nine auxiliary channels are honestly NULL there; a
fresh two-tier pull measures all 24, and the UI renders exactly what the
validated document's per-field `field_status` says — "awaiting upstream" for
real gaps, never a fabricated zero.

`REQUIRE_ALL_FIELDS=true` gates on all 24 parameters; leave it `false` for
field-restricted API clients.

Close any remaining gap with one command against the real API:

```bash
python -m telemetry once --dry-run     # prints accepted values + the `missing` list per vehicle
python -m telemetry fields             # prints the full mapping table
```

Then add the real keys to the `aliases` tuples in `telemetry/fields.py` — one
line per parameter, and the model, ORM and upsert all pick it up automatically.
See `docs/ARCHITECTURE.md` §7.

### Live date resolution

The upstream keys every batch on `date` (default: today, IST). When a batch
has fewer than `LIVE_DATE_MIN_VEHICLES` active vehicles, the engine checks the
current default, recent calendar days and reporting hints, newest first.
`LIVE_DATE_PROBE_DAYS=14` bounds the calendar horizon;
`LIVE_DATE_MAX_PROBES=8` bounds **date-candidate attempts, including failures**
(each candidate separately uses the HTTP retry policy).
A final probe slot may be reserved for a known older fleet. If no batch reaches
the threshold, the richest examined batch is retained and labeled best-effort.

A healthy current feed takes one tier-1 GET. Historical winners are checked
against newer dates **every cycle**, even while the old fleet remains healthy.
`LIVE_DATE_REPROBE_SECONDS=900` throttles full best-effort searches; the current
default is still checked each poll. The dashboard reports probe errors and
thin batches as incomplete, not "upstream has nothing newer". This is a bounded
search, not proof that every upstream date was examined.

Leave `API_DATE` unset for live monitoring. A healthy explicit date is an
intentional filter; `LIVE_DATE_FALLBACK=false` disables searching altogether.

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

### Run the dashboard and HTTP API too

The worker above polls continuously **without a browser**. Starting the HTTP
API by itself does **not** start that worker. In two additional terminals:

```bash
# Same activated venv; from the repository root
python -m uvicorn telemetry.main:app --host 0.0.0.0 --port 8000  # npm run dev:backend
npm ci && npm run dev                                        # dashboard on :3000
```

`telemetry/main.py` contains `app = FastAPI(...)`. Vercel's `api/index.py`
wraps this same app. **`main_parser.py` is an offline converter, not an ASGI
entry point.** `npm run dev:ingest` is an alias for the independent worker.

Local `/api/*` calls proxy to `BACKEND_URL` (default `http://127.0.0.1:8000`).
If Python uses `--port 8001`, change that variable to `http://127.0.0.1:8001`
and restart Next. Browser code always uses relative URLs, not loopback hosts.

Before starting Next, check existing Node processes and ports 3000/3001/3002
(`Get-Process node` + `Get-NetTCPConnection` on Windows, `ps` + `ss`/`lsof`
on Unix). `npm run dev` pins :3000 and fails rather than silently using :3001.
Stop only the verified process for this checkout. Full commands and Vercel
setup: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

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
| `API_BASE_URL` | `https://track.blueenergymotors.com` | no trailing slash; set only for staging or the mock |
| `API_SECRET_KEY` / `API_PASSCODE` | — | **required**; shown once by the admin endpoint |
| `DATABASE_URL` | — | **required**; `postgresql+psycopg://…` (psycopg **3**) |
| `POLL_INTERVAL_SECONDS` | `300` | worker interval; expected cron cadence in diagnostics |
| `TOKEN_REFRESH_INTERVAL` | `3300` | 55 min; the server's token lives 3540 s |
| `TOKEN_EXPIRY_SAFETY_MARGIN` | `240` | headroom kept before expiry |
| `HTTP_MAX_RETRIES` | `5` | 5xx / timeouts only — never 400/401/403/404 |
| `BACKOFF_BASE_SECONDS` / `BACKOFF_MAX_SECONDS` | `1` / `60` | exponential, full jitter |
| `REQUIRE_ALL_FIELDS` | `false` | `true` rejects frames missing any of the 24 parameters |
| `WRITE_UNCHANGED` | `false` | `true` archives a row even when nothing changed |
| `LIVE_DATE_FALLBACK` | `true` | probe for a fresher live batch when a tier-1 batch is empty/dead |
| `LIVE_DATE_MIN_VEHICLES` | `5` | active-vehicle count a batch must reach without probing |
| `LIVE_DATE_PROBE_DAYS` / `LIVE_DATE_MAX_PROBES` | `14` / `8` | walk-back horizon / probe budget per resolution |
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
| `ingestion_runs` | one row per ingestion attempt; 30-day retention | durable poll health across cold starts, including failures/timeouts |

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
# no PostgreSQL needed: 132 pass, the PostgreSQL-backed ones skip
pytest

# everything, including the PostgreSQL upsert tests: 158 pass
export TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@127.0.0.1:5432/twin
pytest

# just the database-independent tests (validation, rotation, retry, live-date)
pytest -k "not repository and not e2e"

# the serverless pre-flight: rewrite -> function -> upstream -> store -> document
make check        # (python tools/serverless_check.py)
```

The PostgreSQL tests *skip* rather than fail without `TEST_DATABASE_URL`,
because the upsert is dialect-specific SQL and a SQLite approximation would
prove nothing about the statement that ships.

What the suite actually proves:

* **158 tests**, no mocking of the code under test — the retry, auth and loop
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

One repository, two runtimes, **one Vercel project**: the Next.js dashboard
lives at the repository root, and `api/index.py` mounts the FastAPI control
plane as a Python serverless function in the same deployment.

```
api/index.py        Vercel entrypoint (ASGI wrapper + path normalizer)
api/requirements.txt the function's runtime dependencies (function-scoped)
telemetry/          the engine (fields → schemas → api/auth → extractor → repository)
telemetry/main.py   FastAPI control plane — DB-backed reads, cron/on-demand ingestion
telemetry/document.py the trusted-document builder (shared by DB reads and offline captures)
main_parser.py      offline capture → validated JSON (dev tool; production reads Neon)
app/ components/ lib/ data/   the Next.js 16 dashboard (@/ alias → repository root)
vercel.json         cron schedule + Python-function config + security headers
next.config.mjs     /api/:path* rewrite → the Python function (Vercel) or uvicorn (dev)
tests/              158 tests, PostgreSQL-gated skips
tools/              mock upstream, smoke test, serverless_check.py pre-flight
deploy/schema.sql   the DDL + the idempotent migration block
docs/               ARCHITECTURE.md — read this
```

### Deploying to Vercel

The repository root **is** the Vercel project root — no Root Directory
override, no legacy `builds`. Framework detection finds `package.json` (Next.js),
`api/index.py` is built as a Python serverless function automatically, and
`vercel.json` schedules the ingestion cron. Full instructions, environment
variables and the health-check checklist are in
**[`DEPLOYMENT.md`](DEPLOYMENT.md)**.

### Dashboard layout

The dashboard is the three-route **Digital Twin** product. The `@/` alias
resolves to the repository root (see `tsconfig.json`).

Swap Station, Chargers and DG were removed from this app (routes deleted,
sidebar entries deleted) and are being built as a separate workstream;
`next.config.mjs` keeps **temporary 307 redirects** for those paths so old
bookmarks land on the Central Dashboard rather than a 404.

```
app/digital-twin/central/            isometric site canvas (road, swap station, chargers, DG)
app/digital-twin/truck-telemetry/    live carrier map + filter bar + 6-field table + 24-param modal
app/digital-twin/battery-tracking/   pack register, 4 KPIs, alerts — live tracking only

components/shell/     AppShell, Sidebar, ThemeToggle, LiveClock
components/map/       FleetMap (SSR-safe wrapper) -> LeafletFleetMap (client only)
components/truck/     TruckFilterBar, TruckTable, TruckDetailModal
components/battery/   BatteryKpiStrip, BatteryFilterBar, BatteryTable
components/central/   SiteCanvas (pure SVG isometric scene)
components/alerts/    AttentionPanel (grouped "Need Attention" banner)
components/ui/        Surface, Pill, Modal, Field, InfoTip, Metric
                      (single light theme; map + site canvas opt into .canvas-dark)

lib/store.ts          Zustand store: filters + bi-directional hover/selection pointer
lib/fleet.ts          filter model, deriveSites + buildGeoIndex (both payload-derived), ETA maths
lib/fleet-metrics.ts  status derivation, KPI coverage types, alerts, table projections
lib/site-model.ts     the ONLY modelled data in the app — facility simulation
lib/theme.ts(x)       dark/light controller (useSyncExternalStore, no FOUC)
lib/telemetry-source.ts  server-only: same-origin document fetch, validation,
                         honest empty-document fallback  <-- the data boundary
lib/document.ts       re-exports the loader + presentation helpers
```

### Live telemetry

`GET /api/telemetry/trusted` (served by `telemetry/main.py`, mounted by
`api/index.py` on Vercel) rebuilds the validated document **from the Neon
`vehicle_state` table on every call** — there is no JSON file in the path any
more. The Next.js server fetches it from its own origin through the
`/api/*` rewrite in `next.config.mjs`, with an abort budget, structural
validation and an honestly-labeled empty document as the only fallback.
Credentials are server-side only — see `.env.example`. The header chip
reports `Connected`, `Cached` or `Waiting` (with the reason) so nobody mistakes
stale or missing data for current data.

Ingestion is scheduled independently: Vercel Cron (`vercel.json`) calls
`GET /api/cron/ingest` **every five minutes**. **This requires a plan supporting
sub-daily Cron (e.g. Pro); on Hobby, replace the managed cron with an external
five-minute scheduler. A once-daily schedule does not meet the requirement.**
`POLL_INTERVAL_SECONDS=300` does not configure Vercel's scheduler by itself.

Each call runs one recorded extraction cycle — vendor API → validation →
PostgreSQL upsert — and returns a summary. `POST /api/ingest/run` and the legacy
`/api/ingest/trigger` alias require the same bearer secret. HTTP **reads never
trigger ingestion**. The browser's first-run auto-trigger is a local-only
convenience; production waits for its scheduler, even with every tab closed.

The independent `python -m telemetry run` worker and Vercel share the same
cycle runner, validation and diagnostics. Every attempt writes an
`ingestion_runs` journal entry and logs timestamp, fleet counts, date selection,
probe failures and outcome. A killed function leaves an unfinished attempt,
not a false success. `GET /api/ingest/status` reads the durable evidence.

The header separates **Connected / Cached / Waiting** from observation age.
The visible ingestion banner distinguishes **Upstream data is old** (a recent
complete poll returned older observations) from **Ingestion failed/overdue**,
**Ingestion incomplete** and a backend/DB outage. A bounded date probe does not
prove that all upstream dates are empty. See the deployment runbook for the
manual-ingest and closed-browser verification checklist.

Because every view iterates `PARAM_ORDER` and reads `field_status`, unlocking
a channel upstream populates the dashboard with **no frontend change** — this
was verified by serving a document with `battery_total_v` and
`charging_status` provisioned: the coverage chip moved 8/24 -> 10/24 and the
"Batteries charging right now" KPI went from *Awaiting upstream* to a live
count.

The carrier map is **Leaflet + OpenStreetMap raster tiles** (`components/map/`), loaded
through `next/dynamic` with `ssr: false` because Leaflet touches `window` at
import time. OSM needs no API key or account (CARTO's basemap CDN now rejects
unauthenticated traffic, which is what produced the "API KEY REQUIRED" tiles).
OSM publishes only a light cartography, so the dark basemap is derived with a
CSS filter rather than a second tile provider — one warm HTTP cache, and
toggling the theme never re-downloads the viewport. **The OSM attribution
control is required by their tile usage policy; do not remove it.**
If the tile CDN is
unreachable, the map falls back to a vector basemap drawn from
`data/india_states.json` — a simplified extract (36 state/UT
MultiPolygons, ~19k points) of the MIT-licensed `states_india.geojson`
(© 2024 Mr Akshay Shinde, https://github.com/mraxays/india-states.geojson —
license text in `data/india_states.LICENSE`). That file is imported
lazily, only on the tile-error path.

Markers are measured GPS fixes only, coloured by live motion state. Hovering a
pin highlights its table row and vice-versa; both directions publish to the
same pointer channel in `lib/store.ts`, which also carries the cross-page
filter state and the `?vehicle_id=` / `?battery_id=` deep links.

Legacy `/trucks` and `/batteries` are 308-redirected to their `/digital-twin/*`
successors in `next.config.mjs`.

Module-by-module explanation in `docs/ARCHITECTURE.md` §2.
