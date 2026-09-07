/**
 * Map projection layer — turns validated rows into map primitives.
 *
 * Kept OUT of the Leaflet component on purpose: `leaflet` touches `window` at
 * import time, so anything that imports it must be `ssr: false`.  Types and
 * pure builders live here instead, which lets server components and tests
 * reason about map data without pulling the map library.
 */

import { formatAge, frameAgeHours } from "@/lib/trusted-telemetry";
import type { AssetStatus, TruckRow } from "@/lib/fleet-metrics";
import { geographicCentroid, normalizeGpsCoordinates } from "@/lib/gps";

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
  rawLat?: number;
  rawLon?: number;
  isCoastalCorrected?: boolean;
  status: AssetStatus;
  soc: number | null;
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

/**
 * Coastal & Terrestrial Map-Matching for Fleet Telemetry.
 *
 * Commercial EV tracking units (OBUs) operating along coastal freight corridors
 * (such as Krishnapatnam Port in Andhra Pradesh) often lose clear GNSS satellite
 * visibility due to metal shipping containers, berths, and crane yards, falling
 * back to maritime cellular tower triangulation (Cell-ID/LBS) or experiencing
 * multipath reflections off open waters. This causes raw GPS coordinates to drift
 * 5–30 km eastward into the Bay of Bengal.
 *
 * This function detects offshore drift beyond the coastline and snaps the
 * displayed marker position to the legitimate terrestrial freight corridor / port facility.
 */
export function snapToTerrestrialCorridor(
  lat: number,
  lon: number,
): { lat: number; lon: number; isCoastalCorrected: boolean } {
  // Andhra Pradesh / Coromandel coastal industrial corridor (Krishnapatnam Port / Nellore):
  if (lat >= 14.15 && lat <= 14.85) {
    // Natural coastline in this sector terminates around 80.05° to 80.14° E.
    if (lon > 80.14) {
      if (lat >= 14.15 && lat <= 14.30) {
        // Krishnapatnam Port Terminal Gate & Coal Berths:
        return { lat: Math.max(lat, 14.248), lon: 80.126, isCoastalCorrected: true };
      }
      if (lat > 14.30 && lat <= 14.50) {
        // Krishnapatnam Port - Mypadu Coastal Expressway:
        return { lat, lon: 80.138, isCoastalCorrected: true };
      }
      if (lat > 14.50 && lat <= 14.70) {
        // Kodavalur - Allur Industrial Freight Corridor:
        return { lat, lon: 80.068, isCoastalCorrected: true };
      }
      if (lat > 14.70 && lat <= 14.85) {
        // Isakapalli / Kavali Industrial Corridor:
        return { lat, lon: 80.045, isCoastalCorrected: true };
      }
    }
  }

  // General East Coast (Bay of Bengal) marine drift check:
  if (lat >= 12.5 && lat <= 21.0) {
    let maxCoastLon = 80.30;
    if (lat >= 13.0 && lat < 14.0) maxCoastLon = 80.30 - (lat - 13.0) * 0.16;
    else if (lat >= 14.0 && lat < 15.0) maxCoastLon = 80.14 - (lat - 14.0) * 0.09;
    else if (lat >= 15.0 && lat < 16.0) maxCoastLon = 80.05 + (lat - 15.0) * 0.55;
    else if (lat >= 16.0 && lat < 17.0) maxCoastLon = 80.60 + (lat - 16.0) * 0.56;
    else if (lat >= 17.0 && lat < 18.0) maxCoastLon = 82.26 + (lat - 17.0) * 1.05;
    else if (lat >= 18.0 && lat <= 21.0) maxCoastLon = 83.31 + (lat - 18.0) * 1.15;

    if (lon > maxCoastLon + 0.01) {
      return { lat, lon: maxCoastLon - 0.01, isCoastalCorrected: true };
    }
  }

  return { lat, lon, isCoastalCorrected: false };
}

/** Only rows with a MEASURED fix are plotted; the rest are reported as
 *  unlocatable by the caller rather than pinned at (0, 0). */
export function buildMapPoints(rows: TruckRow[], now: Date = new Date()): { points: MapPoint[]; unlocatable: TruckRow[] } {
  const points: MapPoint[] = [];
  const unlocatable: TruckRow[] = [];

  for (const row of rows) {
    const rawCoord = normalizeGpsCoordinates(
      row.vehicle.values["latitude"],
      row.vehicle.values["longitude"],
    );
    if (!rawCoord) {
      unlocatable.push(row);
      continue;
    }
    const snapped = snapToTerrestrialCorridor(rawCoord.lat, rawCoord.lon);
    const hours = row.observedAt ? frameAgeHours(row.observedAt, now) : Number.NaN;
    points.push({
      vehicleId: row.vehicleId,
      lat: snapped.lat,
      lon: snapped.lon,
      rawLat: rawCoord.lat,
      rawLon: rawCoord.lon,
      isCoastalCorrected: snapped.isCoastalCorrected,
      status: row.status,
      soc: row.soc,
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
    const centroid = geographicCentroid(members);
    if (!centroid) continue;
    clusters.push({
      id: key,
      city,
      state,
      lat: centroid.lat,
      lon: centroid.lon,
      count: members.length,
      avgSoc: socs.length ? Math.round(socs.reduce((s, v) => s + v, 0) / socs.length) : null,
      vehicleIds: members.map((m) => m.vehicleId),
    });
  }

  return clusters.sort((a, b) => b.count - a.count);
}
