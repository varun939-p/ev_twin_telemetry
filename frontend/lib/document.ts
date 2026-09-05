import "server-only";

import { formatAge, frameAgeHours, type TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

export { loadTelemetry, measuredChannelCount } from "@/lib/telemetry-source";
export type { TelemetrySnapshot } from "@/lib/telemetry-source";
export type { TelemetrySource } from "@/lib/trusted-telemetry";

/**
 * Server-side document helpers.
 *
 * The document itself now comes from `lib/telemetry-source.ts` (live control
 * plane, with the committed snapshot as a fallback). This module keeps the
 * pure presentation helpers that need it, re-exported from one place so pages
 * have a single import.
 *
 * The previous `TRUSTED_DOC` module constant is gone on purpose. A top-level
 * `const` is evaluated once per process, which is exactly wrong for live
 * telemetry: the dashboard would have served the first document it ever read
 * until the container restarted. Fetching per render (behind a revalidate
 * window) is what makes "the second it is unlocked upstream" literally true.
 *
 * IMPORTANT: never import this module from a `"use client"` file. The
 * `server-only` guard turns that into a build error.
 */

/** "12 min ago" / "3.4 h ago" for the shell's freshness chip. */
export function feedFreshnessLabel(doc: TrustedTelemetryDocument, now: Date = new Date()): string {
  const newest = doc.pipeline_health.newest_observed_at;
  if (!newest) return "no timestamp";
  const hours = frameAgeHours(newest, now);
  if (!Number.isFinite(hours)) return "unknown age";
  return `${formatAge(hours)} old`;
}
