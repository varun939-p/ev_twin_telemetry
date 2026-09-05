import "server-only";

import snapshot from "@/data/trusted_vehicle_telemetry.json";
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
 * was fetched from the control plane thirty seconds ago or read from the
 * committed snapshot.
 *
 * ── Trust chain ───────────────────────────────────────────────────────────
 *
 *   vendor v1 API  ──►  main_parser.py  ──►  FastAPI  ──►  Next server  ──►  browser
 *   (secret_key +       (validates every    (serves the   (this module)     (props only)
 *    passcode)           frame, writes       document)
 *                        the document)
 *
 * The credentials live in the Python layer's `.env` and, optionally, in this
 * server's environment. They are NEVER exposed to the browser: this file is
 * marked `server-only`, so importing it from a `"use client"` module is a
 * BUILD error rather than a credential leak discovered in production.
 *
 * ── Why it degrades instead of throwing ───────────────────────────────────
 *
 * An operations dashboard that renders a stack trace when the upstream hiccups
 * is worse than one that renders slightly old data and says so. Every failure
 * path here falls back to the committed snapshot and reports WHY through
 * `source` / `note`, which the shell surfaces as a chip. Nothing is faked and
 * nothing is silently substituted.
 */

/* ------------------------------------------------------------------ config */

interface SourceConfig {
  baseUrl: string;
  docPath: string;
  authPath: string;
  healthPath: string;
  secretKey: string;
  passcode: string;
  revalidateSeconds: number;
  timeoutMs: number;
}

function readConfig(): SourceConfig {
  const env = process.env;
  return {
    // Defaults to the control plane the Next rewrites already point at, so a
    // developer with `uvicorn telemetry.main:app` running gets live data with
    // zero configuration.
    baseUrl: (env.TELEMETRY_API_URL ?? env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, ""),
    docPath: env.TELEMETRY_DOC_PATH ?? "/api/telemetry/trusted",
    authPath: env.TELEMETRY_AUTH_PATH ?? "/api/auth/api-token",
    healthPath: env.TELEMETRY_HEALTH_PATH ?? "/health",
    secretKey: env.TELEMETRY_API_SECRET_KEY ?? "",
    passcode: env.TELEMETRY_API_PASSCODE ?? "",
    // How long a rendered page may serve a cached document. 30s is well
    // inside the parser's poll interval, so the dashboard is never more than
    // one poll behind, and 100 concurrent viewers cost one upstream request.
    revalidateSeconds: positiveInt(env.TELEMETRY_REVALIDATE_SECONDS, 30),
    // A dashboard that hangs is worse than one showing a stale document.
    timeoutMs: positiveInt(env.TELEMETRY_TIMEOUT_MS, 6000),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/* -------------------------------------------------------------------- auth */

interface CachedToken {
  token: string;
  /** Epoch ms after which the token must not be reused. */
  expiresAt: number;
}

let tokenCache: CachedToken | null = null;
/** De-duplicates concurrent token exchanges during a render burst. */
let tokenInFlight: Promise<string | null> | null = null;

/**
 * Exchanges `secret_key` + `passcode` for a short-lived bearer token.
 *
 * Returns `null` when no credentials are configured — the local control plane
 * does not require them, and a missing key must not turn into a failed render.
 *
 * The token is cached in module scope and retired 120s before its stated
 * expiry, so a request can never be issued with a token that dies in flight.
 */
async function getToken(cfg: SourceConfig): Promise<string | null> {
  if (!cfg.secretKey || !cfg.passcode) return null;

  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.token;
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    try {
      const res = await fetchWithTimeout(
        `${cfg.baseUrl}${cfg.authPath}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret_key: cfg.secretKey, passcode: cfg.passcode }),
          cache: "no-store",
        },
        cfg.timeoutMs,
      );
      if (!res.ok) throw new Error(`auth ${res.status}`);

      const body: unknown = await res.json();
      const token = isRecord(body) && typeof body.token === "string" ? body.token : null;
      if (!token) throw new Error("auth response carried no token");

      const ttl = isRecord(body) && typeof body.expires_in === "number" ? body.expires_in : 3540;
      tokenCache = { token, expiresAt: Date.now() + Math.max(ttl - 120, 60) * 1000 };
      return token;
    } catch (err) {
      // Fall through unauthenticated: the endpoint may not require a token.
      // If it does, the document fetch returns 401 and we degrade there with
      // a far more specific message than "auth failed".
      warnOnce("auth", `Token exchange failed (${describe(err)}); continuing unauthenticated.`);
      tokenCache = null;
      return null;
    } finally {
      tokenInFlight = null;
    }
  })();

  return tokenInFlight;
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

  // Spot-check the first frame rather than all 100: this runs on every
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

/* --------------------------------------------------------- liveness probe */

/**
 * Is the control plane answering RIGHT NOW?
 *
 * This exists because the document fetch cannot answer that question. It
 * carries `next: { revalidate }`, and Next's data cache is
 * stale-while-revalidate: when a revalidation fails it replays the last good
 * response, so `res.ok` is true and the code path is indistinguishable from a
 * successful network call. Measured: with the control plane hard down for 65
 * seconds the dashboard still reported "Live from the control plane".
 *
 * Resilience was never the problem — serving the last good document through a
 * blip is exactly right. The problem was the LABEL. An operations dashboard
 * that says "Live" while the feed is dead is worse than one that says nothing,
 * because someone will make a dispatch decision on it.
 *
 * So liveness is probed separately and explicitly:
 *   * `cache: "no-store"` — never satisfied from the data cache, by design;
 *   * a tight timeout, because this must not add latency to a good render;
 *   * it hits `/health`, a few bytes, not the 260 KB document;
 *   * it runs INSIDE the same serverless invocation, so it adds no extra
 *     function calls — only one small round trip we already have a socket for.
 */
async function probeLiveness(cfg: SourceConfig): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${cfg.baseUrl}${cfg.healthPath}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
      Math.min(cfg.timeoutMs, 2_500),
    );
    return res.ok;
  } catch {
    return false;
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

const SNAPSHOT_DOC = normalizeDocument(snapshot as unknown as TrustedTelemetryDocument);

function snapshotResult(note: string): TelemetrySnapshot {
  return { doc: SNAPSHOT_DOC, source: "snapshot", note, fetchedAt: Date.now() };
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

  if (process.env.TELEMETRY_SOURCE === "snapshot") {
    return snapshotResult("Pinned to the committed snapshot by TELEMETRY_SOURCE=snapshot.");
  }

  try {
    const token = await getToken(cfg);
    const res = await fetchWithTimeout(
      `${cfg.baseUrl}${cfg.docPath}`,
      {
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        next: { revalidate: cfg.revalidateSeconds, tags: ["telemetry"] },
      },
      cfg.timeoutMs,
    );

    if (res.status === 401 || res.status === 403) {
      // A wrong key is a configuration bug, not a transient outage. Drop the
      // cached token so the next render re-exchanges rather than replaying a
      // credential the server has already rejected.
      tokenCache = null;
      return snapshotResult(
        `Control plane rejected the credentials (${res.status}). Check TELEMETRY_API_SECRET_KEY / TELEMETRY_API_PASSCODE.`,
      );
    }
    if (!res.ok) {
      return snapshotResult(`Control plane returned ${res.status} for ${cfg.docPath}.`);
    }

    const payload: unknown = await res.json();
    assertDocumentShape(payload);

    // The document may have come from the data cache rather than the wire, so
    // ask the control plane directly whether it is up before claiming "Live".
    const alive = await probeLiveness(cfg);

    // The same normaliser the snapshot goes through, so a live document and a
    // committed one are indistinguishable to every component downstream and
    // all 24 keys are guaranteed present whatever the vendor sent.
    return {
      doc: normalizeDocument(payload),
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
    return snapshotResult(reason);
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

const warned = new Set<string>();
/** One line per distinct problem per process — never a per-request log flood. */
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[telemetry] ${message}`);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
