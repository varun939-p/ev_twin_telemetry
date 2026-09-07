/**
 * Map projection layer — turns validated rows into map primitives.
 *
 * Kept OUT of the Leaflet component on purpose: `leaflet` touches `window` at
 * import time, so anything that imports it must be `ssr: false`.  Types and
 * pure builders live here instead, which lets server components and tests
 * reason about map data without pulling the map library.
 */

import { REFERENCE_CITIES, formatAge, frameAgeHours } from "@/lib/trusted-telemetry";
import type { AssetStatus, TruckRow } from "@/lib/fleet-metrics";

/**
 * Zoom contract — the deep-zoom fix, in one place.
 *   fleet   every asset in frame (Exit Live View resting state)
 *   cluster a city and its ring roads
 *   asset   ~15 km across: a truck plus context, never a rooftop
 *   max     hard ceiling reachable by the user
 */
export const ZOOM = { fleet: 5, cluster: 9, asset: 11, max: 15, min: 3 } as const;

export interface MapPoint {
  vehicleId: string;
  lat: number;
  lon: number;
  status: AssetStatus;
  speedKmh?: number | null;
  soc: number | null;
  batteryLabel: string | null;
  chassis: string;
  city: string | null;
  state: string | null;
  ageLabel: string;
}

export interface MapCluster {
  id: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  count: number;
  avgSoc: number | null;
  vehicleIds: string[];
}

/**
 * The shared DENSITY TIER vocabulary — the one place where a severity colour
 * is decided. The map bubbles, the map legend, the hover cards AND the
 * "Need Attention" hover previews all read these, so a red radar ring on the
 * map and a red preview popover on an alert row are provably the same tier.
 *
 * Lives here (not in the Leaflet component) because the alert panel must not
 * import a module that pulls `leaflet` into the battery-page bundle.
 */
export type HeatTier = "low" | "medium" | "high";

/** Concrete hex for the heat tiers — mirrors the CSS custom properties. */
export const HEAT_TIER_COLOR: Record<HeatTier, string> = {
  low: "#4ade80",
  medium: "#fbbf24",
  high: "#f87171",
};

export const HEAT_TIER_LABEL: Record<HeatTier, string> = {
  low: "Low density",
  medium: "Medium density",
  high: "Severe density",
};

/**
 * Density tier: ratio of the city count to the busiest city, so the palette
 * self-calibrates to ANY fleet size (10 trucks or 10,000) instead of
 * hardcoding absolute thresholds that go stale.
 */
export function densityTier(count: number, maxCount: number): HeatTier {
  const ratio = maxCount > 0 ? count / maxCount : 0;
  if (ratio >= 0.66) return "high";
  if (ratio >= 0.33) return "medium";
  return "low";
}

/** Only rows with a MEASURED fix are plotted; the rest are reported as
 *  unlocatable by the caller rather than pinned at (0, 0). */
export function buildMapPoints(rows: TruckRow[], now: Date = new Date()): { points: MapPoint[]; unlocatable: TruckRow[] } {
  const points: MapPoint[] = [];
  const unlocatable: TruckRow[] = [];

  for (const row of rows) {
    const lat = row.vehicle.values["latitude"];
    const lon = row.vehicle.values["longitude"];
    if (typeof lat !== "number" || typeof lon !== "number") {
      unlocatable.push(row);
      continue;
    }
    const hours = row.observedAt ? frameAgeHours(row.observedAt, now) : Number.NaN;
    points.push({
      vehicleId: row.vehicleId,
      lat,
      lon,
      status: row.status,
      speedKmh: row.speedKmh,
      soc: row.soc,
      batteryLabel: row.batteryLabel,
      chassis: row.chassis,
      city: row.place?.name ?? null,
      state: row.place?.state ?? null,
      ageLabel: Number.isFinite(hours) ? `frame ${formatAge(hours)} old` : "frame age unknown",
    });
  }

  return { points, unlocatable };
}

/**
 * City-level aggregation.
 *
 * Grouped by the nearest reference city rather than a lat/lon grid, because
 * the drill-down has to produce a *filterable* label: clicking the bubble sets
 * `State = Maharashtra, City = Pune`, which only works if the bubble IS a
 * city.  The bubble is anchored on the members' centroid so it sits over the
 * actual trucks, not the city hall.
 */
export function buildCityClusters(points: MapPoint[]): MapCluster[] {
  const byCity = new Map<string, MapPoint[]>();
  for (const p of points) {
    if (!p.city || !p.state) continue;
    const key = `${p.state}::${p.city}`;
    const bucket = byCity.get(key);
    if (bucket) bucket.push(p);
    else byCity.set(key, [p]);
  }

  const clusters: MapCluster[] = [];
  for (const [key, members] of byCity) {
    const [state, city] = key.split("::");
    const socs = members.map((m) => m.soc).filter((s): s is number => s !== null);
    const anchor = REFERENCE_CITIES.find((c) => c.name === city && c.state === state);
    clusters.push({
      id: key,
      city,
      state,
      lat: members.reduce((s, m) => s + m.lat, 0) / members.length || anchor?.lat || 0,
      lon: members.reduce((s, m) => s + m.lon, 0) / members.length || anchor?.lon || 0,
      count: members.length,
      avgSoc: socs.length ? Math.round(socs.reduce((s, v) => s + v, 0) / socs.length) : null,
      vehicleIds: members.map((m) => m.vehicleId),
    });
  }

  return clusters.sort((a, b) => b.count - a.count);
}
