# Production data-path audit — 2026-09-06

**Result: the vehicle read endpoint is database-only, but the blanket claim
“zero hardcoded or simulated values anywhere in the production dashboard” is
not true. A successful production ingestion / Live header is not verified.**

This audit records observations made before pull-request publication; it is
not a live deployment-status page.

## Confirmed in source

The active vehicle-data path is:

```text
Next pages/layout
  → lib/document.ts → lib/telemetry-source.ts:loadTelemetry
  → GET /api/telemetry/trusted
  → telemetry/main.py:trusted_telemetry
  → SELECT VehicleState (vehicle_state in the database selected by DATABASE_URL)
  → telemetry/document.py:document_from_state_rows
```

- `telemetry/main.py:212` selects `VehicleState`; the response is assembled
  from those rows. Missing database configuration / query failures produce
  errors, not a bundled vehicle-data fallback.
- An empty table produces a document with **zero vehicles**. The frontend
  likewise uses an empty document on a failed initial read; it does not invent
  truck records. Its normalizer retains measured values and fills absent
  parameters with `null`, not fabricated readings.
- Next can reuse a previous API response through its short data cache. That is
  not a bundled JSON file; an independent health probe governs the connection
  indicator. A cached response still is not proof of a new upstream pull.
- `blue_energy_response.json` and `live_capture.json` remain repository files,
  but are not read/imported by this active telemetry path. Their contents were
  not used or inspected for credentials during this audit.
- `data/india_states.json` is used by the offline **basemap**, not as a vehicle
  telemetry source.
- The source at the last GitHub-recorded production commit, `dffc618…`, also
  reads `VehicleState`, but still contains the old automatic-ingestion-on-read
  behavior. The working-tree correction removes that behavior.

**Important limit:** “database-only” is not “proven live Neon/vendor data.”
`DATABASE_URL` selects the database, and `API_BASE_URL` selects the upstream.
The code supports local/test databases and mock upstreams by configuration.
Even a healthy `vehicle_state` response cannot by itself prove that its rows
originated from the real vendor. The Arena preview is an isolated mock setup,
not evidence of production data provenance.

## Production UI counterexample to the blanket claim

The Central Dashboard renders this path without a production gate:

```text
app/digital-twin/central/central-view.tsx:170
  → components/central/SiteCanvas.tsx:226
  → lib/site-model.ts:simulateSite
```

It is visibly labelled **FACILITY MODEL**, but it is still simulated:

- `lib/site-model.ts:244–245`: synthesized SOC fallback / animated progression.
- `lib/site-model.ts:171–172`: assumed 60 kW bay and 120 kW gun ratings.
- `lib/site-model.ts:271`: modelled charging power.
- `lib/site-model.ts:288–302`: 250 kW feeder assumption, 125 kW DG rating and
  simulated DG fuel percentage.

These values do not overwrite `/api/telemetry/trusted`, but their presence in a
production-rendered dashboard prevents a “zero simulated values anywhere”
certification. To satisfy that stronger requirement, disable/remove the
facility simulation in production and show unavailable states until a real
facility-controller feed exists. This audit has not silently removed that UI.

## Current deployment observations

The repository's configured homepage is
`https://ev-twin-telemetry.vercel.app`.

- `/api/health` and `/api/telemetry/trusted` still returned the Next.js HTML
  **404** page; a cache-busted health request produced the same result.
- The production truck page showed **zero carriers** and
  `Control plane returned 404 for /api/telemetry/trusted.` It also displayed a
  failed automatic-ingestion message. No successful real-data load was observed.
- The latest GitHub-recorded Production deployment remains commit `dffc618…`
  from `2026-09-06T12:05:15Z` at audit time. The exact-function rewrite
  correction had not yet been published or deployed when these observations
  were recorded.
- Direct sandbox HTTPS probes also failed TLS negotiation. The page checks
  above used the external page reader; neither is evidence of a successful
  authorized ingestion.

Setting variables in Vercel does not deploy these source changes. Environment
changes must also be applied to a new deployment before relying on them.

## Manual ingestion and header verification: blocked

The operator reports that the five production environment variables are set.
Their values are **not available to this agent session**: there is no local
`CRON_SECRET`, Vercel token or authenticated Vercel project configuration.
A manual `POST /api/ingest/run` needs the bearer header; Vercel only supplies it
automatically for its managed cron invocation. No authorized manual POST was
made, and no successful production ingestion is claimed.

After deploying the routing fix, an authorized operator can make exactly one
manual attempt from a secure shell with `CRON_SECRET` already set (do not paste
it into chat):

```bash
curl --fail-with-body --silent --show-error --max-time 70 \
  --request POST 'https://ev-twin-telemetry.vercel.app/api/ingest/run' \
  --header "Authorization: Bearer ${CRON_SECRET:?Set CRON_SECRET securely first}" \
  --header 'Accept: application/json'
```

There is intentionally no retry or redirect-following option. If the request
times out, inspect durable status before deciding whether another attempt is
safe. Verify accepted fleet counts, validation/probe errors, observation
provenance and timestamps, then load the dashboard.

The working-tree header renders **Connected**, not literal **Live**, for
`source === "live"`. That label proves a responding read path, not genuine or
fresh vendor observations. It must not be changed/forced just to make a
production-verification check appear successful.

## Regression coverage added

`test_trusted_endpoint_never_reads_a_bundled_json_fallback` plants tempting JSON
fixtures and blocks JSON-file reads while exercising populated, empty and
unavailable database cases. It asserts that only DB vehicle IDs are returned,
an empty DB stays empty, and an unavailable DB returns an error. This is an
isolated read-boundary test, not a substitute for live Neon verification.
