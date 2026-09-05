import document from "@/data/trusted_vehicle_telemetry.json";
import {
  formatAge,
  frameAgeHours,
  normalizeDocument,
  type TrustedTelemetryDocument,
} from "@/lib/trusted-telemetry";

/**
 * Server-side document boundary.
 *
 * The validated 260 KB document is read HERE and nowhere else, by server
 * components only, and streamed to the views as props — it never enters the
 * client bundle as an import.  Swap this for a `fetch()` against the FastAPI
 * `/telemetry/trusted` route in production and not a single component changes.
 *
 * The cast is the TypeScript boundary only: the shape is guaranteed upstream
 * by `telemetry.schemas.parse_payload`, which validated every field.
 *
 * `normalizeDocument` is the RUNTIME half of the 24-parameter contract — it
 * guarantees every vehicle carries all 24 keys and a verdict for each, whether
 * the backend sent 8 channels or all 24. This is the single place it runs, so
 * no view has to defend against a partial payload, and the day the API unlocks
 * the remaining 16 channels every page populates without a code change.
 *
 * IMPORTANT: never import this module from a `"use client"` file.
 */
export const TRUSTED_DOC = normalizeDocument(document as unknown as TrustedTelemetryDocument);

/** "12 min ago" / "3.4 h ago" for the shell's freshness chip. */
export function feedFreshnessLabel(doc: TrustedTelemetryDocument = TRUSTED_DOC, now: Date = new Date()): string {
  const newest = doc.pipeline_health.newest_observed_at;
  if (!newest) return "no timestamp";
  const hours = frameAgeHours(newest, now);
  if (!Number.isFinite(hours)) return "unknown age";
  return `${formatAge(hours)} old`;
}
