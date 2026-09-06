# Running and deploying EV Twin Telemetry

## Entry points: two HTTP adapters, one ingestion engine

| Entry point | What it actually does |
| --- | --- |
| `python -m uvicorn telemetry.main:app --host 0.0.0.0 --port 8000` | Local FastAPI HTTP control plane. **Does not start a polling loop.** |
| `python -m telemetry run` | Independent continuous worker. Runs immediately, then on `POLL_INTERVAL_SECONDS` ticks; no browser required. |
| `python -m telemetry once` | One recorded ingestion cycle, then exit. |
| `api/index.py:app` | Vercel ASGI adapter. Imports and wraps the **same** `telemetry.main.app`; only normalizes rewritten URL paths. |
| `python main_parser.py ...` | Offline capture-to-JSON converter. **Not a FastAPI app or uvicorn target.** |

There **is** a `telemetry/` package in this checkout. Run commands from the
repository root with the Python virtual environment activated.

Both the worker and HTTP triggers call `telemetry.ingestion.run_recorded_cycle`
→ `TelemetryExtractor.run_cycle` → validator → PostgreSQL upsert. There are
no divergent ingestion implementations. The worker owns its schedule; Vercel
owns the cron schedule. Starting uvicorn alone only serves reads/triggers.

## Local setup

```bash
python -m venv .venv
source .venv/bin/activate          # PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
npm ci
cp .env.example .env              # PowerShell: Copy-Item .env.example .env
# Edit .env privately: DATABASE_URL and the current API credentials.
python -m telemetry init-db
```

Then use **three terminals**, activating the same environment in each:

```bash
# 1: HTTP API (npm run dev:backend is equivalent)
python -m uvicorn telemetry.main:app --host 0.0.0.0 --port 8000

# 2: continuous ingestion (npm run dev:ingest is equivalent)
python -m telemetry run

# 3: dashboard; explicit :3000 prevents silent drift to :3001/:3002
npm run dev
```

`BACKEND_URL=http://127.0.0.1:8000` is a **server-side** proxy target, not a
browser URL. If using `--port 8001`, set `BACKEND_URL=http://127.0.0.1:8001`
and restart Next. Browser requests stay relative (`/api/...`), including
through an Arena/ngrok preview. Next binds `0.0.0.0` and permits `*.e2b.app`.

### Avoid orphaned dev servers

Check what owns the port **before** starting another server. Do not kill every
Node/Python process: identify this repository's process and stop only that one.

```powershell
Get-Process node -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Select-Object ProcessId, CommandLine
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in 3000,3001,3002,8000,8001 }
# After verifying the PID belongs to this checkout: Stop-Process -Id <PID>
```

On Linux/macOS use `ps` plus `ss -ltnp` / `lsof -i :3000`. In Arena, use the
process tools to start/stop servers and keep one identified instance. Test the
same port shown in that instance's startup output.

## Vercel topology

```text
browser → Next.js → /api/* rewrite → api/index.py → telemetry.main.app → Neon
                                                  ↑
                    scheduled authenticated cron (Hobby: once-daily)
                                                  ↓
                                     Blue Energy Motors API
```

No persistent loop runs inside a serverless function. HTTP reads **never**
initiate upstream ingestion. This replaces the old read-triggered ingestion,
which could exceed the dashboard's six-second fetch timeout, depended on
visitors, and bypassed the advertised bearer protection.

### 1. Database and schema

Use the **pooled** Neon endpoint (`-pooler` in the hostname), with TLS and the
psycopg v3 SQLAlchemy driver:

```text
postgresql+psycopg://user:password@ep-xxx-pooler.region.aws.neon.tech/twin?sslmode=require
```

Initialize/migrate **before** deploying:

```bash
python -m telemetry init-db
```

Or apply `deploy/schema.sql` in Neon. For an existing database, use its
idempotent **MIGRATION** block rather than rerunning the initial CREATE TABLEs.
This release adds `ingestion_runs`; it does not drop or rewrite telemetry.
The worker and control plane also ensure the schema on first use. Reviewable
production migrations are preferable to relying on concurrent cold starts.

The pool selector recognizes `postgresql+psycopg`, not just bare `postgresql`.
On Vercel/Lambda, `NullPool` is forced even if `DB_NULLPOOL=false`; Neon handles
connection pooling on its side. Local/dedicated workers retain a QueuePool.

### 2. Project layout and function budget

Import the repository with **Root Directory at the repository root** (not
`frontend`, `backend`, or `telemetry`). Vercel discovers `api/index.py`; its
runtime dependencies are in `api/requirements.txt`. `vercel.json` includes
`telemetry/**` in the Python bundle. `api/index.py:app` is ASGI, not a separate
business-logic handler or a `BaseHTTPRequestHandler`.

**Route to the exact function URL:** production rewrites use
`/api/index.py?__telemetry_path=:path*`, not `/api/index.py/:path*`. A suffix
after `.py` is not a deployed function route and yields Next's HTML 404. The
adapter recovers `/api/...` from the internal query value (or an original path
preserved by the runtime), removes that parameter and preserves the rest of
the query, method, body and authorization header.

The checked-in function budget is **60 seconds**. Date probes and tier-2
requests have bounded concurrency, but retries during a vendor outage can
exceed that budget. Watch `cycle_seconds` and the running/failed journal:
reduce `REQUEST_TIMEOUT` / `HTTP_MAX_RETRIES`, adjust the supported function
budget, or move ingestion to a dedicated worker if the real fleet cannot fit.
A killed function leaves a `running` journal entry, not a fake success. Keep
`INGEST_RUNNING_TIMEOUT_SECONDS` at or below the function budget so a timeout
is flagged before the next cron can mask it with another new attempt. A
dedicated worker can raise this diagnostic threshold if longer cycles are expected.

### 3. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**, scoped
to Production and, if desired, Preview. Prefer a separate Neon branch for
Preview so manual preview tests do not mutate the production snapshot.

| Variable | Required / value |
| --- | --- |
| `DATABASE_URL` | Required. Pooled Neon, `postgresql+psycopg://…?sslmode=require`. |
| `API_SECRET_KEY`, `API_PASSCODE` | Required. Use the **new rotated pair** from the operator's secure store. Never recover them from captures, branches, old logs or chat. |
| `API_BASE_URL` | `https://track.blueenergymotors.com` (also the code default). |
| `CRON_SECRET` | Required on Vercel. Generate/store securely; do not paste into chat. All ingest routes fail closed without it. |
| `POLL_INTERVAL_SECONDS` | Worker cadence. `300` for a continuous worker/real-time external scheduler; set `86400` on Vercel when using the Hobby once-daily cron so diagnostics do not label it overdue. **Does not configure Vercel's scheduler.** |
| `TELEMETRY_REVALIDATE_SECONDS` | `30`. Server document cache window. |
| `TELEMETRY_TIMEOUT_MS` | `6000`. Read timeout, not the ingestion-function timeout. |
| `TELEMETRY_API_URL` | **Leave unset** for same-project deployment. Only set for a separately hosted control plane. |
| `BACKEND_URL` | **Leave unset on Vercel.** Local-only; ignored by production routing/SSR even if accidentally copied. |
| `DB_NULLPOOL` | Optional. Vercel/Lambda force NullPool regardless of `false`. |
| `LIVE_DATE_FALLBACK`, `LIVE_DATE_MIN_VEHICLES` | `true`, `5`; tune the threshold if intentionally monitoring a smaller fleet. |
| `LIVE_DATE_PROBE_DAYS`, `LIVE_DATE_MAX_PROBES` | `14`, `8`; failures count in the attempt budget. |
| `LIVE_DATE_REPROBE_SECONDS` | `900`; limits full best-effort re-searches, not checks of the current default date. |
| `API_DATE` | Leave unset for live monitoring. An explicit healthy date is an intentional filter and is labeled date-limited. |
| `INGEST_RUNNING_TIMEOUT_SECONDS` | `60`, matching the checked-in function budget; diagnostic threshold for a journal entry that never finished, not process cancellation. |

No secret has a `NEXT_PUBLIC_` prefix. None is sent to the browser. Changing
Vercel env values requires a redeploy; changing local settings requires
restarting the affected Python/Next processes. A successful GitHub deployment
status **does not prove** that these values are present, rotated, or correct.
Only a successful authorized upstream pull proves that the configured pair
works; the operator must confirm it is the rotated pair.

### 4. Scheduling (Hobby → once-daily; real-time requires an external scheduler)

The shipped `vercel.json` uses a **Hobby-compatible once-daily** cron so the
deployment is accepted on the free plan:

```json
{ "path": "/api/cron/ingest", "schedule": "0 18 * * *" }
```

`0 18 * * *` runs once a day at 18:00 UTC (23:30 IST). A **sub-daily** cron
(e.g. `*/5 * * * *`) requires a Vercel plan supporting sub-daily Cron (e.g.
Pro) and is **rejected on Hobby** — this is the single change that made the
deployment fail under the previous `*/5` configuration. On Hobby, do **not**
re-add a `*/5` managed cron.

Because a daily cron only ingests once a day, set `POLL_INTERVAL_SECONDS` to
`86400` in the **Vercel environment** so the dashboard does not permanently
label the healthy daily cron as "Ingestion overdue". Keep the local worker at
`300` for real-time development.

If you later want true real-time data (up to about five minutes old) on
Hobby, do **not** switch to a paid plan just for that — instead point an
**external five-minute scheduler** (GitHub Actions, a free cron service) at
the ingestion route. An external scheduler calls:

```text
GET https://<your-app>/api/cron/ingest
Authorization: Bearer <CRON_SECRET>
```

Vercel attaches that bearer header automatically from the project's
`CRON_SECRET`; it must not be embedded in `vercel.json`. External schedulers
must supply the header themselves. Managed Cron runs against Production;
Preview needs an explicit authorized test call or a separate scheduler.

Use **one scheduling owner** per database. The HTTP lock and cooldown are
per warm instance, not a distributed job lock. Duplicate cron delivery or
manual overlap is tolerated by the database's anti-regression/idempotent
upserts, but can still duplicate vendor requests. Do not run a continuous
worker and a cron against the same fleet unless that is intentional.

### Manual/local bootstrap

`POST /api/ingest/run` and the compatibility alias `POST /api/ingest/trigger`
use the same authorization as cron. A blank secret permits local development
only. The browser's `AutoIngestTrigger` is enabled only in non-Vercel development
with no secret. It safely handles non-JSON 5xx, connection errors, 401/403,
409/429, timeout and an empty successful cycle. It is **not a scheduler**.

## Diagnosing staleness without guessing

Two different clocks are visible:

- **Observation age** (`h old`): the source observation in `vehicle_state`,
  not the last HTTP render and not a fabricated current timestamp.
- **Ingestion health**: the latest recorded poll attempt in `ingestion_runs`,
  shared across the worker, warm functions and cold starts.

The connection chip says **Connected / Cached / Waiting**. Connected means the
HTTP app **and database** answered; it is not a claim that telemetry is fresh.
The separate ingestion banner is visible on desktop and mobile:

| State | Meaning / next action |
| --- | --- |
| Ingestion healthy | Recent complete poll and newest observation within the polling window. |
| Upstream data is old | A recent complete poll succeeded but the returned observations are old. No newer qualifying fleet was found **within the probe budget**, not proof that every upstream date was searched. |
| Ingestion incomplete | A thin fleet, validation errors, missing source timestamps, blocked snapshot updates, detail failures or date-probe errors. Newer data cannot be ruled out. |
| Ingestion overdue | No attempt within one interval + 30s grace, or a running attempt exceeded its diagnostic timeout. Check the scheduler/function logs. |
| Ingestion failed / not configured | Auth, upstream, validation, DB or configuration failure. Do not attribute the stale snapshot to upstream silence. |
| Awaiting first ingestion / status unknown | No journal evidence yet; existing data alone cannot prove polling works. |
| Backend / Database unreachable | Read-path failure; any retained observations are labeled cached. |

`GET /api/health` returns HTTP 200 for process liveness even if `database` is
`down`; inspect the JSON body. `GET /api/ingest/status` is an uncached diagnostic
read. `/api/telemetry/trusted` also includes `pipeline_health.ingestion`.

Every recorded cycle logs `ingest_started` then `ingest_finished` or
`ingest_failed`: UTC timestamp, cycle ID, trigger, duration, seen/accepted/
rejected/write counts, detail failures, selected date, active fleet size,
candidate-probe count/errors and threshold satisfaction. Transport retries
within a candidate are governed separately by `HTTP_MAX_RETRIES` and logged
by the HTTP client. Date probes also log their
individual outcomes. `LOG_JSON=true` enables JSON log formatting in both the
worker and HTTP app. Public diagnostics do not echo SQL parameters, upstream
response bodies or credentials. Journal retention is 30 days; ship logs
externally if a longer audit trail is required.

Healthy current-day polls still use one tier-1 GET. Historical fallback dates
are reconsidered every poll, even if they still hold a full fleet. Recent
calendar dates and reporting hints are checked newest-first; the last probe
can be reserved for a known older fleet so a short budget doesn't discard it.
Best-effort full searches respect `LIVE_DATE_REPROBE_SECONDS`, while the
current default is still checked each cycle. A bounded search or an upstream
outage cannot provide an absolute freshness guarantee.

## Verification checklist

Local pre-flight uses **mock upstream data**, not production credentials:

```bash
.venv/bin/python -m pytest                  # PostgreSQL cases need TEST_DATABASE_URL
.venv/bin/python tools/serverless_check.py  # mock → adapter → DB → document
npm test
npm run lint
npm run build
```

`TEST_DATABASE_URL` must be a **disposable database**: those tests truncate its
tables. Never point it at the live Neon database.

After deploying, with `APP_URL` and `CRON_SECRET` set privately in your shell:

```bash
curl -sS "$APP_URL/api/health"
curl -sS -X POST "$APP_URL/api/ingest/run" -H "Authorization: Bearer $CRON_SECRET"
curl -sS "$APP_URL/api/ingest/status"
curl -sS "$APP_URL/api/telemetry/trusted"
```

1. Confirm health reports `database: up` and no configuration errors.
2. Confirm the manual cycle accepted the expected fleet and inspect all date/
   detail/validation diagnostics, not just HTTP 200.
3. Compare `newest_observed_at` before/after. It advances **only if upstream
   supplied fresh valid observations**; a successful unchanged poll advances
   the journal, not the source timestamp.
4. Close every dashboard tab. After at least two cron intervals, verify two
   new successful `trigger: cron` attempts in logs/journal. This proves
   scheduling is independent of the browser.
5. Reopen the dashboard: connection, observation age and ingestion cause must
   agree. Normal propagation is the next poll **plus** cycle duration, the
   30s cache window and the visible-tab refresh interval (20s by default),
   not a hard zero-latency SLA. Hidden/offline tabs refresh when they return.
6. Locally stop the backend and load the dashboard: it must show Backend
   unreachable/Waiting or Cached, never a JSON parsing crash. Stop the worker
   separately to test Ingestion overdue while the HTTP API remains reachable.

Production env checks, plan/cadence confirmation and a successful live ingest
must be performed against the deployment; passing mock tests or reading
`vercel.json` is not a substitute.
