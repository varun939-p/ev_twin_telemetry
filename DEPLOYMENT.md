# Deploying the Digital Twin dashboard to Vercel

> **Read this first.** This repository is a **Python project with a Next.js app
> nested inside it**. Connecting it to Vercel without changing one setting will
> fail the build every time, and no amount of frontend work will show up.

## The one setting that matters

```
repository root/
├── main_parser.py         <-- Python. No package.json here.
├── telemetry/             <-- FastAPI control plane
├── pyproject.toml
└── frontend/              <-- THE NEXT.JS APP LIVES HERE
    ├── package.json
    ├── next.config.mjs
    └── vercel.json
```

Vercel's **Root Directory** defaults to the repository root. There is no
`package.json` there, so the build fails with:

```
Error: No Next.js version detected. Make sure your package.json has "next"
in either "dependencies" or "devDependencies".
Also check your Root Directory setting matches the directory of your package.json file.
```

**Root Directory cannot be set from `vercel.json`** — it is a project setting.
Fix it once, in the dashboard:

> **Vercel → your project → Settings → General → Root Directory → `frontend` → Save**

Then redeploy. Framework preset, build command and output directory are all
detected correctly from that point on; `frontend/vercel.json` supplies the
framework hint, the deployment region and the security headers.

Leave **"Include files outside the Root Directory"** OFF. The dashboard has no
build-time dependency on the Python side — it talks to the control plane over
HTTP at runtime.

## Environment variables

Set these in **Settings → Environment Variables** (Production + Preview). Full
descriptions live in `frontend/.env.example`.

| Variable | Required | Notes |
| --- | --- | --- |
| `TELEMETRY_API_URL` | **yes** | PUBLIC origin of the control plane. A serverless function cannot reach `127.0.0.1`; leaving the default silently serves the committed snapshot. |
| `TELEMETRY_API_SECRET_KEY` | if the control plane is authenticated | Exchanged for a 59-minute bearer token. |
| `TELEMETRY_API_PASSCODE` | if the control plane is authenticated | Issued with the secret key. |
| `TELEMETRY_REVALIDATE_SECONDS` | no (default 30) | Keep at or below the parser's poll interval. |
| `TELEMETRY_TIMEOUT_MS` | no (default 6000) | Abort budget per request. |
| `TELEMETRY_HEALTH_PATH` | no (default `/health`) | Uncached liveness probe backing the Live/Cached distinction. |

None of these are `NEXT_PUBLIC_*`, so none reach the browser.
`lib/telemetry-source.ts` is marked `server-only`, which turns an accidental
client import into a build error rather than a leaked fleet credential.

## What a healthy deployment looks like

Open the dashboard and read the chip in the top-right of the header:

* **`Live · 100 frames · 8/24 · 42 h old`** — the control plane answered. The
  `8/24` is how many telemetry channels the upstream currently measures; it
  rises on its own as the vendor provisions more, with no frontend change.
* **`Cached`** — the control plane is not answering, but Next's data cache
  still holds a document it served earlier, so the dashboard keeps working.
  The readings are as old as the outage, and the tooltip says so. It returns
  to `Live` on its own within one poll (~20 s) once the API recovers — nobody
  has to refresh.
* **`Snapshot`** — the control plane could not be reached. Hover it: the
  tooltip names the exact reason (`Control plane unreachable`, a `4xx`
  rejecting the credentials, or a timeout). The dashboard still renders every
  page from the committed document, so a demo never shows a broken screen —
  but it is not live data. **If you see this after deploying, check
  `TELEMETRY_API_URL` first.**

## Verified pre-flight

Against the production build (`next build && next start`), not just dev:

* builds with **zero** environment variables set;
* with the control plane unreachable, all three routes return **200 in ~0.1 s**
  and render 99 register rows from the snapshot — no crash, no hang;
* no horizontal overflow at 1024, 1280, 1440, 1600, 1920 or 2560 px;
* live refresh polls every 20 s, pauses when the tab is hidden, and leaves no
  interval behind after navigation (measured: 2 refreshes / 45 s visible,
  0 while hidden);
* every panel is wrapped in an error boundary — a synthetic fault in one panel
  leaves the rest of the page rendering, with a retry.

## Not deployed by Vercel

`telemetry/` (FastAPI) and `main_parser.py` are **not** part of this Vercel
project. Host them wherever the vendor API is reachable — the repo's
`Dockerfile` and `docker-compose.yml` cover that — and point
`TELEMETRY_API_URL` at the result.
