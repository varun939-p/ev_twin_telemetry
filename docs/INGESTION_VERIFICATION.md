# Ingestion investigation and verification — 2026-09-06

**Status: implemented and verified locally; not deployed or verified against
live Blue Energy Motors / Neon credentials.** These investigation results
were gathered before pull-request publication; they are not a live deployment
status. No authenticated production ingestion was verified.

## Findings and fixes

| Finding in the original checkout | Change |
| --- | --- |
| `telemetry/` exists. `telemetry/main.py:app` is the real FastAPI entry point; `main_parser.py` is offline-only. Uvicorn does not poll. | Documented separate HTTP and continuous-worker commands. Vercel imports the same app and shared recorded cycle runner. |
| Dashboard GETs could synchronously ingest, and `/api/ingest/trigger` was publicly writable. Browser requests could hit a protected route without auth and parse a plain-text proxy error as JSON. | Reads no longer poll. All ingestion routes share bearer protection, fail closed on Vercel, and release their lock even if initialization fails. Optional browser bootstrap is local-development-only and handles non-JSON/network errors safely. |
| The shipped cron was daily, while ingestion depended on visitors. | Worker default and expected poll interval are 300s; Vercel cron is `*/5 * * * *`. **Sub-daily Cron support (e.g. Pro), or an external scheduler, is required.** Document revalidation remains 30s. |
| A healthy historical fallback could remain sticky. Date-hint ordering and failed-probe accounting could miss newer data. | Current default is checked each cycle; historical winners are reconsidered. Calendar dates/hints are considered newest-first, failures consume candidate budget, and best-effort cooldown does not hide new default-day data. Explicit `API_DATE` is surfaced as a limitation. |
| Health depended on per-process state and observation age did not establish whether polling worked. | Added a 30-day durable `ingestion_runs` journal, structured start/finish/failure events and an uncached diagnostic endpoint/banner. Old upstream observations are distinguished from incomplete, failed, overdue, unconfigured and unavailable ingestion. |
| `postgresql+psycopg` escaped the serverless pool check. | Detect the URL's backend/dialect correctly; force NullPool on Vercel/Lambda even when `DB_NULLPOOL=false`. |
| Ingest-time fallback keys could look like fresh source observations. | Keep history storage semantics, but exclude those keys from document/diagnostic freshness using the validator's existing timestamp-error verdict. The previous UTC parsing and `generated_at`-anchored median implementation is unchanged. |
| A production `/api/*` rewrite appended a path after `.py`, which did not resolve to the deployed function. | Target **`/api/index.py?__telemetry_path=:path*`** exactly. The ASGI adapter restores the route and preserves other query parameters, method, body and authorization. |

## Read-only production evidence

The repository's GitHub homepage identifies
`https://ev-twin-telemetry.vercel.app` as the public app.

- [`/api/health`](https://ev-twin-telemetry.vercel.app/api/health) returned the
  Next.js HTML 404 page, not a health document.
- [`/api/index.py`](https://ev-twin-telemetry.vercel.app/api/index.py) and
  `/api/index` returned FastAPI-style JSON `{"detail":"Not Found"}`: the exact
  function is reachable, but those bare paths do not select a health route.
- `/api/index.py/api/health` returned Next's HTML 404. This supports the
  exact-function rewrite correction above; appending a suffix does not select
  the Python function on the deployed gateway.
- The commit-specific deployment URL reported by GitHub redirected to Vercel
  deployment-protection login. GitHub's prior deployment `success` status does
  not verify the environment or the live data path.

These observations are **before deployment of this patch**. They do not prove
what the vendor's latest available observation is. The original 71-hour age
cannot be conclusively attributed to upstream silence without a successful
authorized real-data cycle and inspection of its date/validation diagnostics.

## Validation performed

| Check | Result |
| --- | --- |
| Full Python suite, with a disposable PostgreSQL 16.2 database | **206 passed**, no skipped integration cases. One dependency deprecation warning. |
| Frontend Vitest/Testing Library tests | **30 passed**: response failures, auth/busy states, Strict Mode/cleanup, disabled bootstrap, DB liveness, local/production URLs, rewrite substitution, status presentation and UTC/median behavior. |
| `npm ci` | Passed; **0 reported vulnerabilities**. Existing production package versions were not upgraded. |
| TypeScript and `VERCEL=1 npm run build` | Passed. Production-mode rewrite configuration compiles. |
| ESLint | No errors; one pre-existing unused `scopeNote` warning in `BatteryKpiStrip.tsx`. |
| `tools/serverless_check.py` | Passed with scratch SQLite, and with PostgreSQL + `VERCEL=1`. Tests the exact-function query route, shared ASGI app, protected manual ingest and rebuilt document. This is not a deployed gateway test. |
| `deploy/schema.sql` | Fresh install and repeated migration block both passed against a disposable PostgreSQL schema. |
| Local HTTP wiring | Actual uvicorn on **:8001** and Next on **:3000**, with `BACKEND_URL` overriding the default. Both direct and proxied health returned HTTP 200 / database up. |
| Independent continuous worker | 26 successful cycles spanning 50s were recorded before browser tests; 78 successful cycles before stopping. Verification used an accelerated **2s** interval; shipped default is **300s**. |
| Manual timestamp advancement | Mock pull accepted 8 vehicles and advanced the document's newest observation from `2026-09-03T13:08:33+00:00` to `2026-09-06T13:10:23+00:00` when the mock began supplying current frames. No fabricated timestamp bump. |
| Real headless Chromium | Truck and battery pages showed old-upstream, healthy, failed and overdue states correctly; overdue banner also visible at mobile width. No page/hydration errors in America/Los_Angeles or Asia/Kolkata tests. |
| Backend-down browser flow | Retained data was labeled Cached with Backend unreachable. A no-cache load exercised the empty-state bootstrap: exactly one POST, plain-text HTTP 500 handled with a friendly toast, no JSON parsing or hydration crash. |
| Process hygiene | Test worker, uvicorn, Next and mock servers stopped after verification; no listeners left on :3000/:3001/:3002/:8000/:8001/:8899. |

## Production work still required

1. Confirm Vercel plan/cadence support, or configure an authenticated external
   five-minute scheduler. Do not silently retain a daily cron.
2. Apply the `ingestion_runs` migration before redeploying. Confirm pooled Neon
   `postgresql+psycopg` + SSL, the **rotated** vendor credential pair, vendor
   base URL and nonempty `CRON_SECRET` in the secure project settings. These
   values were not available to this investigation; do not paste them in chat.
3. Keep `TELEMETRY_API_URL` unset for the same-origin deployment. Clear any
   unintended `API_DATE`; do not copy local `BACKEND_URL` into production.
4. Deploy this patch, then verify `/api/health` is JSON and reports the DB up.
   Run one authorized manual ingest and inspect accepted counts, probe/errors,
   timestamp advancement and the durable status.
5. With dashboard tabs closed, verify at least two scheduled cron cycles.
   Watch real cycle duration against the 60s function budget; unfinished runs
   become overdue after the matching 60s diagnostic threshold.

See [DEPLOYMENT.md](../DEPLOYMENT.md) for setup commands, scheduling/security
choices, state meanings and the full operator checklist.
