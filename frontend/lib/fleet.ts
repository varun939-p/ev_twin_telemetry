/**
 * Fleet-domain derivation layer for the Trucks / Batteries pivot.
 *
 * Pure and React-free.  Everything here is computed from the validated
 * `TrustedTelemetryDocument` only -- no invented telemetry.  Where the upstream
 * feed has no value (null), helpers return `null` and the UI renders an
 * "unavailable" state, never a fabricated `0`.
 *
 * Product pivot: trucks are carriers; battery packs are the tracked asset.
 * A battery is derived from a truck frame whose id carries an `_EV<n>` suffix
 * (e.g. `51230911020019_ev2`).  The numeric chassis is the truck; `<n>` is the
 * battery slot.  Only the active EVs (currently 3) become battery packs.
 */

import {
  REFERENCE_CITIES,
  haversineKm,
  nearestCity,
  numericValue,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";

/* ------------------------------------------------------------------ filters */

export type EvFilter = "all" | "ev" | "non-ev";

export interface GeoSelection {
  /** Level 1 -- any of `INDIA_STATES`, or null for "All states". */
  state: string | null;
  /** Level 2 -- a city within the chosen state, or null for "All cities". */
  city: string | null;
}

export interface FocusSelection {
  /** Stable id for the drill-down (cluster key or candidate key). */
  id: string;
  /** Human label, e.g. "Pune, Maharashtra". */
  label: string;
  /** Vehicle ids that belong to the drilled-down scope. */
  vehicleIds: string[];
}

export interface FilterState {
  ev: EvFilter;
  geo: GeoSelection;
  focus: FocusSelection | null;
}

/** The 28 Indian states + NCT Delhi = 29, for the Level-1 cascade. */
export const INDIA_STATES: readonly string[] = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Delhi",
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
  "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal",
];

/** Level-2 options per state, drawn from the reference-city anchors. */
export const CITIES_BY_STATE: Readonly<Record<string, readonly string[]>> = (() => {
  const map: Record<string, string[]> = {};
  for (const city of REFERENCE_CITIES) {
    (map[city.state] ??= []).push(city.name);
  }
  for (const key of Object.keys(map)) map[key].sort();
  return map;
})();

/* ------------------------------------------------------------ ev / battery */

const EV_SUFFIX = /_EV(\d+)$/i;

export function isEvVehicle(vehicleId: string): boolean {
  return EV_SUFFIX.test(vehicleId);
}

/** `51230911020019_ev2` -> 2, else null. */
export function batterySlot(vehicleId: string): number | null {
  const m = EV_SUFFIX.exec(vehicleId);
  return m ? Number(m[1]) : null;
}

/** `51230911020019_ev2` -> `51230911020019`. */
export function truckChassis(vehicleId: string): string {
  return vehicleId.replace(EV_SUFFIX, "");
}

/** `51230911020019_ev2` -> `Battery 2`, else null. */
export function batteryLabel(vehicleId: string): string | null {
  const slot = batterySlot(vehicleId);
  return slot === null ? null : `Battery ${slot}`;
}

export interface BatteryAsset {
  batteryId: string;
  truckId: string;
  slot: number;
  vehicle: TrustedVehicle;
}

/** Active EV frames become battery packs, capped to the live EV count. */
export function deriveBatteries(vehicles: TrustedVehicle[], limit = 3): BatteryAsset[] {
  return vehicles
    .map((vehicle) => {
      const slot = batterySlot(vehicle.vehicle_id);
      return slot === null ? null : { batteryId: `Battery ${slot}`, truckId: truckChassis(vehicle.vehicle_id), slot, vehicle };
    })
    .filter((b): b is BatteryAsset => b !== null)
    .sort((a, b) => a.slot - b.slot)
    .slice(0, limit);
}

/* -------------------------------------------------------------------- geo */

export function vehicleGeo(vehicle: TrustedVehicle): { lat: number; lon: number } | null {
  const lat = numericValue(vehicle, "latitude");
  const lon = numericValue(vehicle, "longitude");
  return lat === null || lon === null ? null : { lat, lon };
}

export function vehicleCity(vehicle: TrustedVehicle): { name: string; state: string } | null {
  const geo = vehicleGeo(vehicle);
  if (!geo) return null;
  const near = nearestCity(geo.lat, geo.lon);
  return { name: near.name, state: near.state };
}

export function applyVehicleFilters(vehicles: TrustedVehicle[], filters: FilterState): TrustedVehicle[] {
  return vehicles.filter((v) => {
    if (filters.ev === "ev" && !isEvVehicle(v.vehicle_id)) return false;
    if (filters.ev === "non-ev" && isEvVehicle(v.vehicle_id)) return false;

    if (filters.geo.state) {
      const place = vehicleCity(v);
      if (!place || place.state !== filters.geo.state) return false;
      if (filters.geo.city && place.name !== filters.geo.city) return false;
    }

    if (filters.focus && !filters.focus.vehicleIds.includes(v.vehicle_id)) return false;
    return true;
  });
}

/** Per-state asset counts so the cascade can badge real coverage. */
export function stateCounts(vehicles: TrustedVehicle[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of vehicles) {
    const place = vehicleCity(v);
    if (place) counts[place.state] = (counts[place.state] ?? 0) + 1;
  }
  return counts;
}

/* --------------------------------------------------- predictive arrival */

/** Assumptions (client-tunable later): pack size + heavy-truck consumption. */
export const PACK_CAPACITY_KWH = 282;
export const CONSUMPTION_KWH_PER_KM = 1.2;
export const AVG_CRUISE_KMH = 40;

/** The two live swap hubs; destination is the nearer one to the truck. */
export const SWAP_STATIONS: ReadonlyArray<{ name: string; state: string; lat: number; lon: number }> = [
  { name: "Pune Swap Hub", state: "Maharashtra", lat: 18.5204, lon: 73.8567 },
  { name: "Raurkela Swap Hub", state: "Odisha", lat: 22.2601, lon: 84.83 },
];

export interface ArrivalEstimate {
  rangeKm: number | null;
  station: { name: string; state: string } | null;
  distanceKm: number | null;
  etaMinutes: number | null;
  /** true when remaining range covers the distance to the destination. */
  feasible: boolean;
}

export function predictArrival(vehicle: TrustedVehicle): ArrivalEstimate {
  const soc = numericValue(vehicle, "soc");
  const geo = vehicleGeo(vehicle);

  const rangeKm = soc === null ? null : (soc / 100) * PACK_CAPACITY_KWH / CONSUMPTION_KWH_PER_KM;

  if (!geo) {
    return { rangeKm, station: null, distanceKm: null, etaMinutes: null, feasible: false };
  }

  let station = SWAP_STATIONS[0];
  let distanceKm = Number.POSITIVE_INFINITY;
  for (const s of SWAP_STATIONS) {
    const d = haversineKm(geo.lat, geo.lon, s.lat, s.lon);
    if (d < distanceKm) {
      distanceKm = d;
      station = s;
    }
  }
  const rounded = Math.round(distanceKm);
  const etaMinutes = Math.round((distanceKm / AVG_CRUISE_KMH) * 60);

  return {
    rangeKm: rangeKm === null ? null : Math.round(rangeKm),
    station: { name: station.name, state: station.state },
    distanceKm: rounded,
    etaMinutes,
    feasible: rangeKm !== null && rangeKm >= distanceKm,
  };
}

/* ------------------------------------------------------------ formatting */

export function formatEta(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} h ${String(m).padStart(2, "0")} m`;
}
