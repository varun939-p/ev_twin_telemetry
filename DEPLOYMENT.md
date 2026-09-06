# Deploying the Digital Twin to Vercel

> **The architecture in one sentence:** one Vercel project serves the Next.js
> dashboard AND a Python serverless function (`api/index.py`); every request
> for `/api/*` is rewritten to that function, which reads/writes **Neon
> PostgreSQL**; a Vercel Cron job pulls the fleet from Blue Energy Motors into
> Neon on a schedule. There is no background process, no local file, and no
> second deployment.

```
                     ┌──────────────────────────────────────────────────┐
                     │  ONE VERCEL PROJECT (repository root)            │
   browser ────────► │  Next.js 16 (app/, force-dynamic pages)          │
                     │      │  rewrites /api/:path*  (next.config.mjs)  │
                     │      ▼                                          │
                     │  api/index.py  — Python serverless function      │
                     │      │  telemetry.main.py (FastAPI)              │
   Vercel Cron ────► │      │   GET  /api/cron/ingest  (Bearer secret)  │
   (every 5 min*)    │      │   GET  /api/telemetry/trusted             │
                     │      ▼                                          │
                     │  Neon PostgreSQL  ◄── vendor pull on demand      │
                     └──────────────────────────────────┬───────────────┘
                                                        │
                                        https://track.blueenergymotors.com
```

\* Pro plan. Hobby allows one cron run per day — see "Cron cadence" below.

---

## Step 1 — Neon PostgreSQL

1. Create (or reuse) the project at [neon.tech](https://neon.tech).
2. Copy the **pooled** connection string (it contains `-pooler`), e.g.
   `postgresql+psycopg://user:password@ep-xxx-pooler.region.aws.neon.tech/twin?sslmode=require`.
   Pooled is the right choice for serverless functions: hundreds of short-lived
   connections would exhaust a direct endpoint.
3. Initialize the schema — either:

   ```bash
   DATABASE_URL="postgresql+psycopg://…" python -m telemetry init-db
   ```

   …or run `deploy/schema.sql` in the Neon SQL editor. **Already running the
   previous schema?** Nothing to redo: `init-db` (and the control plane's
   process start-up) runs the idempotent migration block — `provisioned_sites`
   plus the three validator-verdict columns on `vehicle_state`
   (`field_status`, `missing_fields`, `field_errors`). The function adds them
   on first boot; you do not need to touch the database by hand.

## Step 2 — Create the Vercel project

1. Import the repository. **Root Directory stays at the repository root** —
   the Next.js app lives at the root, and Vercel auto-detects it.
2. That's it for the build. `api/index.py` is discovered automatically and
   built with the Python runtime; `api/requirements.txt` is its dependency
   list (kept separate from the root `requirements.txt`, which also carries
   dev tooling). `vercel.json` pins the function's `maxDuration: 120` /
   `memory: 1024`, registers the cron and sets the security headers.

## Step 3 — Environment variables

Set in **Settings → Environment Variables** (Production + Preview):

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | Neon pooled URL, `postgresql+psycopg://…?sslmode=require`. The function forces NullPool on Vercel — no socket outlives an invocation. |
| `API_SECRET_KEY` | **yes** (ingestion) | Blue Energy Motors client key. |
| `API_PASSCODE` | **yes** (ingestion) | Shown once when issued. |
| `CRON_SECRET` | **yes** (ingestion) | Generate with `openssl rand -base64 32`. Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically; external schedulers must send it explicitly. **The ingest routes fail closed without it.** |
| `TELEMETRY_REVALIDATE_SECONDS` | no (default 30) | Document cache window for server renders. Keep ≤ the cron interval. |
| `TELEMETRY_TIMEOUT_MS` | no (default 6000) | Abort budget for the document fetch + health probe. |
| `TELEMETRY_API_URL` | no | Only when hosting the control plane somewhere else entirely. Unset = same origin (the default, and the point). |

None of these are `NEXT_PUBLIC_*`, so none reach the browser bundle;
`lib/telemetry-source.ts` is marked `server-only`, which turns an accidental
client import into a build error.

## Step 4 — Cron cadence

`vercel.json` ships `"*/5 * * * *"` on `/api/cron/ingest` — five-minute fleet
refreshes, which is the product's heartbeat.

- **Hobby plan:** cron expressions may only fire **once per day**; a `*/5`
  schedule fails at deploy time. Either (a) replace the schedule with a daily
  one (e.g. `"17 4 * * *"`) while evaluating, or (b) delete the `crons` block
  and point any external scheduler (cron-job.org, GitHub Actions, UptimeRobot)
  at:

  ```
  GET https://<your-app>.vercel.app/api/cron/ingest
  Authorization: Bearer <CRON_SECRET>
  ```

- **Pro plan:** the shipped schedule works as-is. Cron hits only run against
  production deployments, never previews.

## Step 5 — Verify

Run the pre-flight **before** deploying (no Vercel account, no credentials —
it uses the bundled mock upstream and a scratch store):

```bash
make setup && make check
```

Then, against the deployed project:

| Check | Expected |
| --- | --- |
| `curl https://<app>/api/health` | `{"status":"ok","database":"up",…}` |
| `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/ingest` | `{"ok":true,"summary":{"accepted":8,…}}` |
| `curl https://<app>/api/telemetry/trusted` | document with `"vehicles"` populated (or the honest empty document on first boot) |
| Open the dashboard, read the header chip | **`Live · 8 frames · 24/24 · <age> old`** |

The chip's three states:

* **`Live`** — the control plane answered this render and the database holds
  ingested vehicles.
* **`Cached`** — the function is unreachable, but Next's data cache still
  holds the last good document; readings are as old as the outage and the
  tooltip says so. It returns to `Live` on its own.
* **`Waiting`** — there is no document yet (empty database, cron not fired,
  credentials pending). The tooltip names the exact reason. **If you see this
  after deploying, run the cron route once by hand and check the function
  logs.**

## What changed in the 2026-09 serverless migration

| Before (broken on Vercel) | After |
| --- | --- |
| `python -m telemetry run` — a 24/7 polling loop | Vercel Cron + on-demand `POST /api/ingest/run`, each running **one** cycle. The loop still ships for Docker/dedicated servers. |
| `trusted_vehicle_telemetry.json` rewritten on disk | Deleted from the data path. The document is rebuilt from `vehicle_state` on every read; per-field verdicts are persisted at ingest time. |
| FastAPI serving a local file, Next pointing at `TELEMETRY_API_URL` | One deployment: `next.config.mjs` rewrites `/api/*` → `api/index.py` (same origin). `TELEMETRY_API_URL` remains as an override. |
| Frontend falling back to a committed snapshot | Frontend falls back to an honestly-labeled **empty** document (`Waiting`), never to stale or fabricated data. |
| File-backed site provisioning (`provisioned_sites.json`) | Append-only `provisioned_sites` table in Neon. |
| `POST /api/ingest/upload` file drop-zone | Removed (`410 Gone`) — serverless filesystems are ephemeral. |

## Self-hosted alternative (unchanged)

`Dockerfile` + `docker-compose.yml` still run the engine as a long-lived
poller (`python -m telemetry run`) with its own PostgreSQL — useful if you
want sub-minute cadences without Vercel. Point `TELEMETRY_API_URL` at it and
the same dashboard reads it over the same endpoint.
