# "Backend unreachable (HTTP 500)" — Root-Cause Analysis & Live-Data Runbook

**Status: FIXED.** The full pipeline now boots with one command and serves the real
fleet. This document explains exactly what was broken, which files/URLs/env vars
were involved, and how to run the pipeline in replay mode or fully live mode —
locally and on Vercel.

---

## 1. Symptom

The dashboard rendered with:

* toast — `Backend unreachable (HTTP 500). Check that the control plane is running
  and the proxy target is correct.`
* banner — `Control plane unreachable (fetch failed).`
* header chip — `Waiting · 0 frames · 0 / 24 · no timestamp`
* `0 of 0 carriers in scope carry a measured fix` — no trucks anywhere.

## 2. Root cause (verified, not guessed)

The telemetry chain is **four processes deep**, and only ONE of them was running:

```
browser ──► Next.js (:3000) ──rewrite /api/*──► uvicorn control plane (:8000) ──SQLAlchemy──► PostgreSQL
                                                      ▲
                                        polling worker (`python -m telemetry run`)
                                                      │
                                        Blue Energy upstream (track.blueenergymotors.com)
```

The Next.js dev log showed the smoking gun:

```
Failed to proxy http://127.0.0.1:8000/api/health Error: connect ECONNREFUSED 127.0.0.1:8000
Failed to proxy http://127.0.0.1:8000/api/telemetry/trusted Error: connect ECONNREFUSED 127.0.0.1:8000
```

**Nobody ever started the Python control plane.** `npm run dev` starts ONLY the
frontend. Every `/api/*` request was rewritten to `http://127.0.0.1:8000` (the
default `BACKEND_URL`) where nothing listened → the OS answered `ECONNREFUSED` →
Next's proxy surfaced it as **HTTP 500** → the UI labels were working exactly as
designed.

Three compounding layers sat underneath:

| Layer | File | Problem |
|---|---|---|
| Process wiring | `package.json` (`dev` vs `dev:backend` vs `python -m telemetry run`) | Three separate commands, three terminals; the dashboard alone shows zero data. No single-command path existed. |
| Database config | `telemetry/config.py` (`database_url` default `postgres:postgres@localhost:5432/twin`) | With no `.env`, the control plane tried a **local PostgreSQL that does not exist**, so even a started backend reported `database: down`. There is no `.env` in the checkout — only `.env.example`. |
| Upstream credentials | `.env.example` (`API_SECRET_KEY`, `API_PASSCODE`) | Real-time polling requires the Blue Energy client credentials issued once by the vendor portal. They were never present in this environment, so no worker could pull live frames. |

### What was NOT broken

* `next.config.mjs` rewrites — the proxy target, path handling and the Vercel
  function rewrite are all correct (proven by `tests/frontend/rewrite-config.test.ts`).
* The frontend boundary (`lib/telemetry-source.ts`) — it degraded honestly to the
  labeled empty state instead of faking data. That is why the screen said
  "Waiting · 0 frames" rather than showing garbage.
* CORS, `allowedDevOrigins`, `vercel.json`, `api/index.py` — untouched and fine.

## 3. The fix

### 3.1 One command boots the whole pipeline

```bash
npm run dev:all          # or: make devstack
```

`scripts/dev-stack.mjs` (new) owns every process, waits for each one to be
genuinely healthy, color-codes their logs, and tears everything down on Ctrl+C:

1. **Database** — boots a REAL local PostgreSQL (bundled server binaries via
   `pgserver`; data lives in gitignored `.pgdata/`) via `tools/dev_postgres.py`
   (new). If `DATABASE_URL` already points at Neon or another host, it uses that
   instead and starts nothing.
2. **Data** — with no upstream credentials, replays the **REAL captured fleet**
   (`live_capture.json` — a 2026-09-04 capture of an actual engine run, 100
   vehicles) through the engine's own validated write path
   (`tools/replay_capture.py`, new → `TelemetryRepository.write_cycle`). This is
   **not** the synthetic mock generator; every frame is a real observation with
   its original `observed_at`, and the journal row honestly says
   `trigger="replay"`. Set `REPLAY_CAPTURE=false` to disable.
3. **Control plane** — `uvicorn telemetry.main:app` on :8000, health-checked
   before anything else starts.
4. **Polling worker** — started ONLY when `API_SECRET_KEY` + `API_PASSCODE` are
   set (it never hammers the real upstream with empty credentials).
5. **Dashboard** — `npm run dev` on :3000.

`npm run dev` still exists unchanged (frontend-only) for Docker/Vercel parity.

### 3.2 `.env` (created, gitignored, never committed)

Contains a working local `DATABASE_URL`, empty credential slots with
instructions, and replay-friendly polling windows. Fill in the two credential
lines and the same command becomes fully live — no code changes.

### 3.3 Verified end-to-end (this exact checkout)

```
GET /api/health              via :3000 → 200 {"status":"ok","database":"up", ...}
GET /api/telemetry/trusted   via :3000 → 200, 100 real vehicles
header chip     → "Connected · 100 frames · 8/24 · 3 d old"
carrier table   → "100 of 100 carriers", "10 moving"
ingestion banner→ "Ingestion is not configured: set API_SECRET_KEY, API_PASSCODE."
                  (the honest go-live instruction, not an error)
```

`tsc` clean · eslint clean · 35/35 tests · `next build` passes.

## 4. Complete integration map (everything you asked to know)

### Ports & processes (local)

| Port | Process | Started by | Reads |
|---|---|---|---|
| 3000 | Next.js dashboard | `npm run dev` (or `dev:all`) | `.env` (DASHBOARD section) |
| 8000 | FastAPI control plane | `dev:all`, `make api`, `npm run dev:backend` | `.env` (CONTROL PLANE section) |
| — | polling worker | `dev:all` (live mode only), `make run` | `.env` (POLLING section) |
| 5432-ish | local PostgreSQL | `dev:all` (`tools/dev_postgres.py`) | nothing (prints `DATABASE_URL`) |

### Environment variables — who reads what, where

| Variable | Read by | Local | Vercel |
|---|---|---|---|
| `DATABASE_URL` | Python engine/control plane (`telemetry/config.py`) | in `.env` | Project → Settings → Environment Variables (use the **pooled** Neon URL) |
| `API_SECRET_KEY`, `API_PASSCODE` | Python engine (`telemetry/api.py`, `telemetry/auth.py`) | in `.env` | same, set on Vercel |
| `CRON_SECRET` | ingest-route auth (`telemetry/main.py::_authorize_ingest`) | optional locally | **required** (routes fail closed; Vercel Cron sends it as Bearer automatically) |
| `BACKEND_URL` | **Next.js only** — `next.config.mjs` local rewrite target | `http://127.0.0.1:8000` | **must NOT be set** (an SSR fetch to loopback cannot work in a serverless function; the code guards this) |
| `TELEMETRY_API_URL` | `lib/telemetry-source.ts` | unset (= own origin) | unset (= own origin → the Python function) |
| `TELEMETRY_DOC_PATH` / `TELEMETRY_HEALTH_PATH` | `lib/telemetry-source.ts` | `/api/telemetry/trusted`, `/api/health` | same |
| `TELEMETRY_REVALIDATE_SECONDS`, `TELEMETRY_TIMEOUT_MS` | `lib/telemetry-source.ts` | 30 s / 6 s | same |
| `VERCEL` | `next.config.mjs`, `lib/telemetry-source.ts`, engine | unset | set by the platform |
| `POLL_INTERVAL_SECONDS` | engine cadence + overdue diagnostics | 86400 in replay; **300 when live** | 86400 on Hobby cron, 300 for continuous |
| `API_DATE`, `API_VEHICLE_FILTER` | upstream query | unset for live monitoring | unset |

### URLs on the wire

1. Browser → `http://localhost:3000/api/*` (same origin, no CORS).
2. Next rewrite (local) → `http://127.0.0.1:8000/api/*` — **the ECONNREFUSED point**.
3. Next rewrite (Vercel) → `/api/index.py?__telemetry_path=<route>` (the Python
   serverless function in the same project).
4. Control plane → `postgresql+psycopg://…neon.tech/twin?sslmode=require` (or the
   local socket URL in dev).
5. Worker → `https://track.blueenergymotors.com/api/auth/api-token`,
   `/api/v1/vehicles`, `/api/v1/vehicles/{id}` (and `/api/dashboard-parameters`
   when available).

## 5. Going fully LIVE (real-time vendor polling)

1. Paste your Neon **pooled** connection string into `DATABASE_URL` in `.env`
   (or keep the local one — the engine writes wherever this points).
2. Paste `API_SECRET_KEY` and `API_PASSCODE` (issued once by
   `POST /api/admin/api-clients`; the passcode is shown only once).
3. Set `POLL_INTERVAL_SECONDS=300` for a 5-minute cadence.
4. Restart `npm run dev:all` — the `[worker]` process appears in the log and the
   ingestion banner clears after the first successful cycle.

### On Vercel

Set in Project → Settings → Environment Variables (Production + Preview):
`DATABASE_URL` (pooled), `API_SECRET_KEY`, `API_PASSCODE`, `CRON_SECRET`,
`POLL_INTERVAL_SECONDS` (86400 on Hobby). Do **not** set `BACKEND_URL` or
`TELEMETRY_API_URL`. `vercel.json` already schedules `GET /api/cron/ingest`;
the full checklist is in `DEPLOYMENT.md`.

## 6. The three error labels, decoded

| Label | Produced by | Meaning |
|---|---|---|
| `Backend unreachable (HTTP 500). Check that the control plane is running…` | `lib/ingest-response.ts` (manual/auto ingest trigger) | The `/api/ingest/run` POST died in the Next rewrite — nothing on :8000. |
| `Control plane unreachable (fetch failed).` | `lib/telemetry-source.ts` catch | The SSR document fetch threw (ECONNREFUSED family). |
| `Backend unreachable. Showing any cached observations…` | `probeLiveness` in `lib/telemetry-source.ts` | `/api/health` did not answer — header stays honest (`Waiting`/`Cached`), never "Live". |
| `The backend is responding but the database is unavailable…` | `probeLiveness` | Backend up, `database != "up"` — check `DATABASE_URL`. |

## 7. Files added/changed by this fix

* `scripts/dev-stack.mjs` — the orchestrator (new).
* `tools/dev_postgres.py` — real local PostgreSQL supervisor (new).
* `tools/replay_capture.py` — real-capture loader through the engine's own
  repository code, with an honest `trigger="replay"` journal row (new).
* `.env` — local dev configuration (created; **gitignored, never committed**).
* `package.json` — `dev:all` (+ `dev:frontend` alias); `dev` unchanged.
* `Makefile` — `make devstack`.
* `.gitignore` — `.pgdata/`.
