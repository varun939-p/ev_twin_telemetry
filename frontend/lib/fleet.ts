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

/** SOC brackets exposed on the Battery Tracking filter bar. */
export type SocBracket = "all" | "gt20" | "gt50" | "gt80";

export const SOC_BRACKETS: ReadonlyArray<{ id: SocBracket; label: string; min: number }> = [
  { id: "all", label: "All SOC", min: -1 },
  { id: "gt20", label: "SOC > 20%", min: 20 },
  { id: "gt50", label: "SOC > 50%", min: 50 },
  { id: "gt80", label: "SOC > 80%", min: 80 },
];

export interface GeoSelection {
  /** Level 0 -- macro region ("West", "South", ...), or null for all. */
  region: string | null;
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

/**
 * The asset the map and the asset lists are jointly pointing at.
 *
 * This is the bi-directional half of the geo map: `origin: "map"` selections
 * make the host page scroll the asset's card into view and open its parameter
 * panel; `origin: "list"` selections make the map camera fly to the truck.
 * `seq` increments on every selection (including re-selecting the same
 * asset) so consumers can react to repeated clicks.  A pointer, not a filter:
 * it narrows nothing.
 */
export interface AssetSelection {
  vehicleId: string;
  origin: "map" | "list";
  seq: number;
}

export interface FilterState {
  ev: EvFilter;
  geo: GeoSelection;
  focus: FocusSelection | null;
  /** Battery Tracking only -- narrows packs by charge bracket. */
  soc: SocBracket;
  /** Battery Tracking only -- packs whose nearest hub is this station. */
  stationId: string | null;
}

/** Macro regions for the Level-0 filter.  A state maps to exactly one. */
export const REGIONS: readonly string[] = ["North", "West", "Central", "South", "East", "North-East"];

const REGION_OF_STATE: Readonly<Record<string, string>> = {
  "Delhi": "North", "Haryana": "North", "Punjab": "North", "Himachal Pradesh": "North",
  "Uttarakhand": "North", "Uttar Pradesh": "North", "Rajasthan": "North",
  "Maharashtra": "West", "Gujarat": "West", "Goa": "West",
  "Madhya Pradesh": "Central", "Chhattisgarh": "Central",
  "Karnataka": "South", "Kerala": "South", "Tamil Nadu": "South", "Telangana": "South",
  "Andhra Pradesh": "South",
  "Odisha": "East", "West Bengal": "East", "Bihar": "East", "Jharkhand": "East", "Sikkim": "East",
  "Assam": "North-East", "Arunachal Pradesh": "North-East", "Manipur": "North-East",
  "Meghalaya": "North-East", "Mizoram": "North-East", "Nagaland": "North-East", "Tripura": "North-East",
};

export function regionOfState(state: string | null): string | null {
  return state ? (REGION_OF_STATE[state] ?? null) : null;
}

/** States inside a macro region, for the cascading Region -> State dropdown. */
export function statesInRegion(region: string | null): readonly string[] {
  if (!region) return INDIA_STATES;
  return INDIA_STATES.filter((s) => REGION_OF_STATE[s] === region);
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

/**
 * Product pivot: a frame is a battery asset when it carries a *measured* SOC
 * -- a live pack is reporting.  Frames without pack telemetry are carriers
 * only ("Non-EV" in the filter's language).  Deliberately NOT keyed on the
 * `_EV<n>` id suffix: the live v1 feed uses chassis plates, and the battery
 * is what we track.
 */
export function isEvVehicle(vehicle: TrustedVehicle): boolean {
  return numericValue(vehicle, "soc") !== null;
}

/** `51230911020019_ev2` -> 2, else null. */
export function batterySlot(vehicleId: string): number | null {
  const m = EV_SUFFIX.exec(vehicleId);
  return m ? Number(m[1]) : null;
}

/** `51230911020019_ev2` -> `51230911020019`; plain ids pass through. */
export function truckChassis(vehicleId: string): string {
  return vehicleId.replace(EV_SUFFIX, "");
}

export interface BatteryIdentity {
  /** Executive-facing asset name: "Battery 1", "Battery 2", ... */
  label: string;
  /** The carrier chassis this pack is mounted in. */
  chassis: string;
}

/**
 * Stable battery identity for the WHOLE fleet.  Every EV frame becomes
 * "Battery N" (1-based, ordered by vehicle id) and the truck is reduced to
 * its carrier chassis.  Pages build this once from the full vehicle list and
 * pass it down, so labels never shift with the active filter scope.
 */
export function batteryRegistry(vehicles: TrustedVehicle[]): ReadonlyMap<string, BatteryIdentity> {
  const registry = new Map<string, BatteryIdentity>();
  vehicles
    .filter((vehicle) => isEvVehicle(vehicle))
    .sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id))
    .forEach((vehicle, index) => {
      registry.set(vehicle.vehicle_id, {
        label: `Battery ${index + 1}`,
        chassis: truckChassis(vehicle.vehicle_id),
      });
    });
  return registry;
}

export interface BatteryAsset {
  batteryId: string;
  truckId: string;
  slot: number;
  vehicle: TrustedVehicle;
}

/** Active EV frames become battery packs -- all of them, not a capped few. */
export function deriveBatteries(vehicles: TrustedVehicle[], limit = Number.POSITIVE_INFINITY): BatteryAsset[] {
  const registry = batteryRegistry(vehicles);
  return vehicles
    .filter((vehicle) => isEvVehicle(vehicle))
    .sort((a, b) => a.vehicle_id.localeCompare(b.vehicle_id))
    .map((vehicle) => {
      const identity = registry.get(vehicle.vehicle_id);
      return {
        batteryId: identity?.label ?? vehicle.vehicle_id,
        truckId: identity?.chassis ?? truckChassis(vehicle.vehicle_id),
        slot: batterySlot(vehicle.vehicle_id) ?? 0,
        vehicle,
      };
    })
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
    if (filters.ev === "ev" && !isEvVehicle(v)) return false;
    if (filters.ev === "non-ev" && isEvVehicle(v)) return false;

    if (filters.geo.region || filters.geo.state) {
      const place = vehicleCity(v);
      if (!place) return false;
      if (filters.geo.region && regionOfState(place.state) !== filters.geo.region) return false;
      if (filters.geo.state && place.state !== filters.geo.state) return false;
      if (filters.geo.city && place.name !== filters.geo.city) return false;
    }

    if (filters.soc && filters.soc !== "all") {
      const soc = numericValue(v, "soc");
      const min = SOC_BRACKETS.find((b) => b.id === filters.soc)?.min ?? -1;
      // An unmeasured SOC is not "> 20%" -- it is unknown, so it drops out of
      // a bracket filter rather than being silently treated as 0.
      if (soc === null || soc <= min) return false;
    }

    if (filters.stationId && nearestStation(v)?.id !== filters.stationId) return false;

    if (filters.focus && !filters.focus.vehicleIds.includes(v.vehicle_id)) return false;
    return true;
  });
}

/** The neutral filter -- exported so callers can build partial scopes safely. */
export const EMPTY_FILTERS: FilterState = {
  ev: "all",
  geo: { region: null, state: null, city: null },
  focus: null,
  soc: "all",
  stationId: null,
};

/** Per-state asset counts so the cascade can badge real coverage. */
/**
 * DATASET-DERIVED GEOGRAPHY INDEX.
 *
 * The dropdowns used to be fed from the static `INDIA_STATES` list, so an
 * operator scrolled past 25 states with no assets to reach the 4 that had
 * any. That is a browsing UI, not an operations one.
 *
 * This walks the fleet ONCE and returns only the regions, states and cities
 * that actually have carriers in the loaded document, each with its live
 * count. Nothing is hardcoded: when the backend starts returning vehicles in
 * Karnataka, "South / Karnataka / Bengaluru" appears in the filters by
 * itself. `REGION_OF_STATE` stays as the classification lookup — that is
 * reference data (which region a state belongs to), not a list of options.
 *
 * Counts are computed on the UNFILTERED fleet so the options do not vanish
 * as the operator narrows the scope — a dropdown whose contents disappear
 * while you use it is impossible to navigate back out of.
 */
export interface GeoOption {
  value: string;
  count: number;
}

export interface GeoIndex {
  /** Regions with at least one asset, in canonical REGIONS order. */
  regions: GeoOption[];
  /** All states with assets, in canonical order. */
  states: GeoOption[];
  /** States with assets, keyed by region. */
  statesByRegion: Record<string, GeoOption[]>;
  /** Cities with assets, keyed by state. */
  citiesByState: Record<string, GeoOption[]>;
  /** Assets carrying no usable GPS fix, so they land in no bucket. */
  unplaced: number;
}

export function buildGeoIndex(vehicles: TrustedVehicle[]): GeoIndex {
  const stateCount = new Map<string, number>();
  const regionCount = new Map<string, number>();
  const cityCount = new Map<string, Map<string, number>>();
  let unplaced = 0;

  for (const v of vehicles) {
    const place = vehicleCity(v);
    if (!place) {
      unplaced += 1;
      continue;
    }
    stateCount.set(place.state, (stateCount.get(place.state) ?? 0) + 1);

    const region = regionOfState(place.state);
    if (region) regionCount.set(region, (regionCount.get(region) ?? 0) + 1);

    let cities = cityCount.get(place.state);
    if (!cities) {
      cities = new Map();
      cityCount.set(place.state, cities);
    }
    cities.set(place.name, (cities.get(place.name) ?? 0) + 1);
  }

  const states: GeoOption[] = [...stateCount.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));

  const statesByRegion: Record<string, GeoOption[]> = {};
  for (const option of states) {
    const region = regionOfState(option.value);
    if (region) (statesByRegion[region] ??= []).push(option);
  }

  const citiesByState: Record<string, GeoOption[]> = {};
  for (const [state, cities] of cityCount) {
    citiesByState[state] = [...cities.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  return {
    regions: REGIONS.filter((r) => regionCount.has(r)).map((value) => ({
      value,
      count: regionCount.get(value) ?? 0,
    })),
    states,
    statesByRegion,
    citiesByState,
    unplaced,
  };
}

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

/** The live swap hubs.  `id` is the stable key used by the station filter and
 *  by the Swap Station route; destination is the nearest hub to the truck. */
export interface SwapStation {
  id: string;
  name: string;
  state: string;
  lat: number;
  lon: number;
  /** Physical bays at the site -- drives the Swap Station bay scaffold. */
  bays: number;
}

export const SWAP_STATIONS: ReadonlyArray<SwapStation> = [
  { id: "pune-hub", name: "Pune Swap Hub", state: "Maharashtra", lat: 18.5204, lon: 73.8567, bays: 4 },
  { id: "raurkela-hub", name: "Raurkela Swap Hub", state: "Odisha", lat: 22.2601, lon: 84.83, bays: 4 },
];

/** Nearest hub to a vehicle's measured fix, or null when it has no fix. */
export function nearestStation(vehicle: TrustedVehicle): (SwapStation & { distanceKm: number }) | null {
  const geo = vehicleGeo(vehicle);
  if (!geo) return null;
  let best = SWAP_STATIONS[0];
  let bestKm = Number.POSITIVE_INFINITY;
  for (const s of SWAP_STATIONS) {
    const km = haversineKm(geo.lat, geo.lon, s.lat, s.lon);
    if (km < bestKm) {
      bestKm = km;
      best = s;
    }
  }
  return { ...best, distanceKm: Math.round(bestKm) };
}

export interface ArrivalEstimate {
  rangeKm: number | null;
  station: { id: string; name: string; state: string } | null;
  distanceKm: number | null;
  etaMinutes: number | null;
  /** true when remaining range covers the distance to the destination. */
  feasible: boolean;
}

export function predictArrival(vehicle: TrustedVehicle): ArrivalEstimate {
  const soc = numericValue(vehicle, "soc");
  const rangeKm = soc === null ? null : ((soc / 100) * PACK_CAPACITY_KWH) / CONSUMPTION_KWH_PER_KM;
  const station = nearestStation(vehicle);

  if (!station) {
    return { rangeKm, station: null, distanceKm: null, etaMinutes: null, feasible: false };
  }

  return {
    rangeKm: rangeKm === null ? null : Math.round(rangeKm),
    station: { id: station.id, name: station.name, state: station.state },
    distanceKm: station.distanceKm,
    etaMinutes: Math.round((station.distanceKm / AVG_CRUISE_KMH) * 60),
    feasible: rangeKm !== null && rangeKm >= station.distanceKm,
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
