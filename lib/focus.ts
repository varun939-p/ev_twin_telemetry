/**
 * Cross-page focus routing — the single helper every "show me this vehicle on
 * the map" surface goes through.
 *
 * CONTRACT (management mandate): clicking a specific vehicle in a "Need
 * Attention" panel or a fleet list must land the operator on the Truck
 * Telemetry page, auto-scroll to the map, and fly/zoom to that truck.
 *
 * Split of responsibilities:
 *   * OFF-page sources (Central Dashboard rows, Battery Tracking tables and
 *     battery alerts) navigate with `?vehicle_id=<id>` — a plain, shareable
 *     URL. The Truck Telemetry deep-link handler does the select + scroll +
 *     fly (see truck-telemetry-view.tsx).
 *   * ON-page sources (truck alerts, carrier fleet rows) cannot "route" —
 *     they are already there — so they call `scrollMapIntoView()` and fly
 *     through the store. Same observable behaviour, no history churn.
 *
 * This module is deliberately React-free (no hooks, no router): it is callable
 * from effects, event handlers and tests alike, and `scrollIntoView` is
 * guarded so server render and jsdom never explode.
 */

/** DOM id of the map card on the Truck Telemetry page. */
export const MAP_ANCHOR_ID = "carrier-map";

/** Deep-link query parameter consumed by the Truck Telemetry view. */
export const VEHICLE_DEEP_LINK_PARAM = "vehicle_id";

/** `/digital-twin/truck-telemetry?vehicle_id=<id>` — the cross-page focus URL. */
export function truckFocusHref(vehicleId: string): string {
  return `/digital-twin/truck-telemetry?${VEHICLE_DEEP_LINK_PARAM}=${encodeURIComponent(vehicleId)}`;
}

/**
 * Smooth-scroll the fleet map into view. No-ops safely when the map is not
 * mounted (wrong page, jsdom, SSR) — callers never need a null check.
 */
export function scrollMapIntoView(): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(MAP_ANCHOR_ID);
  if (!el || typeof el.scrollIntoView !== "function") return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}
