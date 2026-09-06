import "server-only";

import { headers } from "next/headers";
import {
  PARAM_ORDER,
  normalizeDocument,
  type TelemetrySource,
  type TrustedTelemetryDocument,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";

/**
 * THE LIVE TELEMETRY BOUNDARY.
 *
 * Exactly one module in the app knows where telemetry comes from. Everything
 * downstream receives a `TrustedTelemetryDocument` and cannot tell whether it
 * was fetched from the control plane thirty seconds ago or is the
 * "nothing ingested yet" document.
 *
 * ── Trust chain ───────────────────────────────────────────────────────────
 *
 *   vendor v1 API  ──►  extraction cycle (cron or on demand)  ──►  Neon
 *   (secret_key +       telemetry/main.py validates every          │
 *    passcode)          frame and upserts vehicle_state            │
 *                                                                  ▼
 *   browser  ◄──  Next server components  ◄──  GET /api/telemetry/trusted
 *                 (this module)               rebuilds the document from
 *                                             Neon on every call
 *
 * The control plane lives in the SAME deployment: `next.config.mjs` rewrites
 * `/api/:path*` onto the Python serverless function (`api/index.py`), so the
 * default base URL is this deployment's own origin — no second service, no
 * CORS, no `127.0.0.1` in production. `TELEMETRY_API_URL` still wins if a
 * standalone control plane is ever deployed elsewhere.
 *
 * The credentials live only in the serverless function's environment
 * (`DATABASE_URL`, `API_SECRET_KEY`, `API_PASSCODE`, `CRON_SECRET`). They are
 * NEVER exposed to the browser: this file is marked `server-only`, so
 * importing it from a `"use client"` module is a BUILD error rather than a
 * credential leak discovered in production.
 *
 * ── Why it degrades instead of throwing ───────────────────────────────────
 *
 * An operations dashboard that renders a stack trace when the upstream
 * hiccups is worse than one that renders honestly-labeled emptiness. There is
 * NO committed snapshot file any more — the local JSON was a stateful
 * artifact a serverless platform cannot rewrite, and every fallback path here
 * therefore lands on the EMPTY document (`source: "waiting"`, named reason in
 * `note`, surfaced by the header chip). Nothing is faked and nothing is
 * silently substituted.
 */

/* ------------------------------------------------------------------ config */

interface SourceConfig {
  baseUrl: string;
  docPath: string;
  healthPath: string;
  revalidateSeconds: number;
  timeoutMs: number;
}

function readConfig(): SourceConfig {
  const env = process.env;
  return {
    // Empty means "this deployment" — the rewrite carries /api/* to the
    // Python function in the same Vercel project. In local development the
    // absolute URL points at `next start` itself, whose rewrite proxies the
    // call on to `uvicorn telemetry.main:app`.
    baseUrl: "", // resolved per request in resolveBaseUrl()
    docPath: env.TELEMETRY_DOC_PATH ?? "/api/telemetry/trusted",
    healthPath: env.TELEMETRY_HEALTH_PATH ?? "/api/health",
    // How long a rendered page may serve a cached document. 30s keeps the
    // dashboard at most one cron window behind, and 100 concurrent viewers
    // cost one function invocation.
    revalidateSeconds: positiveInt(env.TELEMETRY_REVALIDATE_SECONDS, 30),
    // A dashboard that hangs is worse than one showing a stale document.
    timeoutMs: positiveInt(env.TELEMETRY_TIMEOUT_MS, 6000),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Where the control plane lives for THIS request.
 *
 * `TELEMETRY_API_URL` (a standalone Python deployment) overrides everything.
 * Otherwise the base is the request's own origin — derived from the
 * forwarded-host headers Vercel sets, so the same code serves the production
 * domain, a preview URL and `vercel dev` without configuration. Outside a
 * request context (or locally) it falls back to the loopback `next start`
 * address; the dev rewrite proxies /api/* to the local control plane.
 */
async function resolveBaseUrl(): Promise<string> {
  const configured = process.env.TELEMETRY_API_URL ?? process.env.BACKEND_URL ?? "";
  if (configured) return configured.replace(/\/+$/, "");

  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
      return `${proto}://${host}`;
    }
  } catch {
    // Not inside a request (build-time prerender, a script) — fall through.
  }
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/* --------------------------------------------------------- liveness probe */

/**
 * Is the control plane answering RIGHT NOW?
 *
 * This exists because the document fetch cannot answer that question. It
 * carries `next: { revalidate }`, and Next's data cache is
 * stale-while-revalidate: when a revalidation fails it replays the last good
 * response, so `res.ok` is true and the code path is indistinguishable from a
 * successful network call.
 *
 * Resilience was never the problem — serving the last good document through a
 * blip is exactly right. The problem was the LABEL. An operations dashboard
 * that says "Live" while the feed is dead is worse than one that says
 * nothing, because someone will make a dispatch decision on it.
 *
 * So liveness is probed separately and explicitly:
 *   * `cache: "no-store"` — never satisfied from the data cache, by design;
 *   * a tight timeout, because this must not add latency to a good render;
 *   * it hits `/api/health`, a few bytes, not the document;
 *   * it runs INSIDE the same serverless invocation, so it adds no extra
 *     function calls — only one small round trip we already have a socket for.
 */
async function probeLiveness(cfg: SourceConfig): Promise<boolean> {
  try {
    const baseUrl = await resolveBaseUrl();
    const res = await fetchWithTimeout(
      `${baseUrl}${cfg.healthPath}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
      Math.min(cfg.timeoutMs, 2_500),
    );
    return res.ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- validation */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural gate on anything arriving over the wire.
 *
 * This is NOT re-validating the telemetry — the Python data layer already did
 * that, and duplicating its rules here would create two sources of truth that
 * drift. It only proves the payload is the document shape the UI expects, so
 * a proxy error page or an HTML login redirect can never be rendered as a
 * fleet of zero trucks.
 *
 * Deliberately tolerant about the 24 parameters: a frame carrying 3 keys is
 * valid input, because `normalizeVehicle` fills the rest as `absent_upstream`.
 * That tolerance is the whole point of the contract — the upstream can unlock
 * channels without a frontend release.
 */
function assertDocumentShape(payload: unknown): asserts payload is TrustedTelemetryDocument {
  if (!isRecord(payload)) throw new Error("payload is not an object");
  if (!Array.isArray(payload.vehicles)) throw new Error("payload.vehicles is not an array");
  if (!isRecord(payload.pipeline_health)) throw new Error("payload.pipeline_health is missing");

  // Spot-check the first frame rather than all of them: this runs on every
  // revalidate, and a malformed feed is malformed at frame 0.
  const [first] = payload.vehicles as unknown[];
  if (first !== undefined) {
    if (!isRecord(first)) throw new Error("vehicles[0] is not an object");
    if (typeof first.vehicle_id !== "string" || first.vehicle_id.length === 0) {
      throw new Error("vehicles[0].vehicle_id is missing");
    }
    if (!isRecord(first.values)) throw new Error("vehicles[0].values is missing");
  }
}

/* ------------------------------------------------------------------ result */

export type { TelemetrySource };

export interface TelemetrySnapshot {
  doc: TrustedTelemetryDocument;
  /** Where this document came from — surfaced in the shell, never hidden. */
  source: TelemetrySource;
  /** Operator-readable reason. Non-null unless `source === "live"`. */
  note: string | null;
  /** Epoch ms the document entered this process. */
  fetchedAt: number;
}

/**
 * The zero-data document, in the exact shape `assertDocumentShape` demands.
 *
 * This is what renders while the database is empty (first deployment, cron
 * not fired yet, upstream credentials pending). Every page's empty state and
 * the header chip read `source`/`note` and say WHY — an honest blank beats a
 * fabricated truck or a crashed render.
 */
const EMPTY_DOCUMENT: TrustedTelemetryDocument = normalizeDocument({
  schema_version: "1.0",
  generated_at: new Date(0).toISOString(),
  provenance: {
    source_file: "not-ingested-yet",
    source_encoding: "utf-8",
    source_bytes: 0,
    input_shape: "postgres_snapshot",
    upstream_request: null,
    validator: "telemetry.repository (PostgreSQL upsert)",
    source_timezone: "Asia/Kolkata",
    require_all_fields: false,
    database_written: true,
  },
  pipeline_health: {
    vehicles_seen: 0,
    vehicles_accepted: 0,
    vehicles_quarantined: 0,
    parameters_total: 24,
    parameters_available: 0,
    parameters_unavailable_upstream: 24,
    fleet_completeness_pct: 0,
    oldest_observed_at: null,
    newest_observed_at: null,
    available_parameters: [],
    unavailable_parameters: [],
    attention: [],
  },
  field_status_legend: {
    measured: "value present and passed validation -- render normally",
    absent_upstream: "upstream did not send this key -- gray out, 'awaiting upstream'",
    null_upstream: "upstream sent the key with a null/empty value -- gray out, 'no reading'",
    field_error: "value was rejected by validation and stored NULL -- gray out, show error",
  },
  vehicles: [],
  quarantined: [],
} as unknown as TrustedTelemetryDocument);

function waitingResult(note: string): TelemetrySnapshot {
  return { doc: EMPTY_DOCUMENT, source: "waiting", note, fetchedAt: Date.now() };
}

/* ----------------------------------------------------------------- loading */

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  // `AbortSignal.timeout` is not honoured by Next's patched fetch in every
  // runtime, so the controller is driven explicitly.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Loads the current telemetry document.
 *
 * Call this from server components only. It is safe to call several times per
 * request: Next dedupes identical `fetch`es within a render pass, and the
 * revalidate window shares one upstream response across every concurrent
 * viewer.
 */
export async function loadTelemetry(): Promise<TelemetrySnapshot> {
  const cfg = readConfig();

  try {
    const baseUrl = await resolveBaseUrl();
    const res = await fetchWithTimeout(
      `${baseUrl}${cfg.docPath}`,
      {
        headers: { Accept: "application/json" },
        next: { revalidate: cfg.revalidateSeconds, tags: ["telemetry"] },
      },
      cfg.timeoutMs,
    );

    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      const sentence =
        isRecord(detail) && typeof detail.detail === "string"
          ? ` The control plane says: ${detail.detail}`
          : "";
      return waitingResult(`Control plane returned ${res.status} for ${cfg.docPath}.${sentence}`);
    }

    const payload: unknown = await res.json();
    assertDocumentShape(payload);

    // The document may have come from the data cache rather than the wire, so
    // ask the control plane directly whether it is up before claiming "Live".
    const alive = await probeLiveness(cfg);

    // The same normaliser every document goes through, so a live document and
    // the empty one are indistinguishable to every component downstream and
    // all 24 keys are guaranteed present whatever the vendor sent.
    const doc = normalizeDocument(payload);
    if (doc.vehicles.length === 0) {
      return {
        doc,
        source: "waiting",
        note: "The database is reachable but no vehicle has been ingested yet. The cron job (or POST /api/ingest/run) will fill this in.",
        fetchedAt: Date.now(),
      };
    }

    return {
      doc,
      source: alive ? "live" : "cached",
      note: alive
        ? null
        : "Control plane is not responding. Showing the last document it served — these readings are as old as the outage.",
      fetchedAt: Date.now(),
    };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `Control plane did not respond within ${cfg.timeoutMs} ms.`
        : `Control plane unreachable (${describe(err)}).`;
    return waitingResult(reason);
  }
}

/**
 * Coverage of the live feed, for the shell chip.
 *
 * Reports how many of the 24 parameters the upstream is currently measuring
 * anywhere in the fleet. This is the number that moves the day the vendor
 * provisions a channel, and it moves with no frontend change — which is the
 * property the whole pipeline exists to guarantee.
 */
export function measuredChannelCount(doc: TrustedTelemetryDocument): number {
  const live = new Set<string>();
  for (const vehicle of doc.vehicles as TrustedVehicle[]) {
    for (const param of PARAM_ORDER) {
      if (vehicle.field_status[param] === "measured") live.add(param);
    }
    if (live.size === PARAM_ORDER.length) break;
  }
  return live.size;
}

/* ------------------------------------------------------------------ logging */

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
