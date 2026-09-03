/**
 * Typed contract for `trusted_vehicle_telemetry.json` + the pure selectors both
 * components share.
 *
 * HARD RULE: this module reads nothing but the validated document produced by
 * the Python data layer (`main_parser.py` -> `telemetry.schemas.parse_payload`).
 * There is no fallback data, no default vehicle, and no synthesised value
 * anywhere in this file.  If a field is `null` upstream, it stays `null` here
 * and the UI is responsible for showing it as unavailable -- never as `0`.
 *
 * Keep this file free of React and of JSON imports: the page (a server
 * component) owns the document and passes it down, so the 260 KB payload is
 * never shipped inside the client bundle.
 */

/* ------------------------------------------------------------------ types */

/** Per-parameter verdict written by the data layer. Anything != "measured" is
 *  rendered disabled.  Values are exhaustive -- see `field_status_legend`. */
export type FieldStatus = "measured" | "absent_upstream" | "null_upstream" | "field_error";

export type ParamValue = number | string | null;

export interface FieldError {
  field: string;
  raw: unknown;
  error: string;
}

export interface TrustedVehicle {
  vehicle_id: string;
  observed_at: string | null;
  observed_at_utc: string | null;
  /** Present in the output only because the frame survived validation. */
  trusted: boolean;
  signature: string;
  measured_count: number;
  completeness_pct: number;
  /** Parameter keys the upstream never sent (the 9 unprovisioned fields). */
  missing_fields: string[];
  /** Parameter keys sent with a null/empty value. */
  null_fields: string[];
  field_errors: FieldError[];
  field_status: Record<string, FieldStatus>;
  /** Always all 24 keys, product-spec order, explicit nulls. */
  values: Record<string, ParamValue>;
}

export interface ParameterHealth {
  field: string;
  label: string;
  unit: string;
  logical_type: string;
  documented_upstream: boolean;
  vehicles_with_value: number;
  coverage_pct: number;
  status: "available" | "unavailable_upstream";
  status_breakdown: Record<string, number>;
}

export interface AttentionItem {
  vehicle_id: string;
  reason: string;
  measured_count: number;
  completeness_pct: number;
  observed_at: string | null;
}

export interface PipelineHealth {
  vehicles_seen: number;
  vehicles_accepted: number;
  vehicles_quarantined: number;
  parameters_total: number;
  parameters_available: number;
  parameters_unavailable_upstream: number;
  fleet_completeness_pct: number;
  oldest_observed_at: string | null;
  newest_observed_at: string | null;
  available_parameters: ParameterHealth[];
  unavailable_parameters: ParameterHealth[];
  attention: AttentionItem[];
}

export interface Provenance {
  source_file: string;
  source_encoding: string;
  source_bytes: number;
  input_shape: string;
  upstream_request: { method: string; url: string; date: string | null } | null;
  validator: string;
  source_timezone: string;
  require_all_fields: boolean;
  database_written: boolean;
  extra?: Record<string, unknown>;
}

export interface TrustedTelemetryDocument {
  schema_version: string;
  generated_at: string;
  provenance: Provenance;
  pipeline_health: PipelineHealth;
  field_status_legend: Record<FieldStatus, string>;
  vehicles: TrustedVehicle[];
  quarantined: unknown[];
}

/** Admin-supplied variables that scope one isolated twin.  The upstream feed
 *  carries no site key today, so this is the parameterisation shell the
 *  dashboard is built around -- not a claim that per-site data exists. */
export interface SiteConfig {
  siteId: string;
  label: string;
  customer: string;
  chargers: number;
  dgCapacityKw: number;
  gridFeederKw: number;
  /** Present only once the data layer can attribute frames to a site. */
  vehicleFilter?: (vehicle: TrustedVehicle) => boolean;
}

/* ------------------------------------------------------- canonical layout */

/** Product-spec order of the 24 parameters (source of truth: telemetry/fields.py). */
export const PARAM_ORDER: readonly string[] = [
  "soc",
  "soh",
  "odometer_km",
  "residual_mileage_km",
  "charge_cycles",
  "battery_temp_c",
  "min_cell_v",
  "max_cell_v",
  "max_temp_c",
  "min_temp_c",
  "regen_kwh",
  "speed_kmh",
  "total_power_kwh",
  "charging_status",
  "battery_avg_temp_c",
  "battery_total_v",
  "battery_current_a",
  "max_cell_v_cell_no",
  "min_cell_v_pack_no",
  "min_cell_v_cell_no",
  "max_temp_pack_no",
  "work_status",
  "latitude",
  "longitude",
] as const;

/**
 * The 9 parameters the upstream does not measure: the auxiliary thermal and
 * secondary sub-pack diagnostics.  Mirrors `telemetry.fields.UNMEASURED_NAMES`,
 * which pins them to NULL in the validator.
 *
 * Declaring them here too is deliberate: a tile's disabled state must not be
 * inferable only from whatever a document happens to contain.  These render
 * grayed out unconditionally, and are never substituted with a zero -- an
 * absent measurement and a zero reading are opposite claims about the truck.
 */
export const UNMEASURED_FIELDS: ReadonlySet<string> = new Set([
  "total_power_kwh",
  "charging_status",
  "battery_total_v",
  "battery_current_a",
  "max_cell_v_cell_no",
  "min_cell_v_pack_no",
  "min_cell_v_cell_no",
  "max_temp_pack_no",
  "work_status",
]);

/** True for the permanently-absent parameters, regardless of document content. */
export function isUnmeasured(field: string): boolean {
  return UNMEASURED_FIELDS.has(field);
}

/** Tile grouping for the Digital Twin panel. Every parameter appears exactly once. */
export const FIELD_GROUPS: ReadonlyArray<{ id: string; title: string; fields: readonly string[] }> = [
  {
    id: "energy",
    title: "Energy & Range",
    fields: ["soc", "soh", "residual_mileage_km", "odometer_km", "charge_cycles", "regen_kwh", "total_power_kwh", "charging_status"],
  },
  { id: "pack", title: "Pack Electricals", fields: ["battery_total_v", "battery_current_a", "battery_avg_temp_c"] },
  { id: "cells", title: "Cell Balancing", fields: ["min_cell_v", "max_cell_v", "max_cell_v_cell_no", "min_cell_v_pack_no", "min_cell_v_cell_no"] },
  { id: "thermal", title: "Thermal", fields: ["battery_temp_c", "max_temp_c", "min_temp_c", "max_temp_pack_no"] },
  { id: "motion", title: "Motion & State", fields: ["speed_kmh", "work_status"] },
  { id: "position", title: "Position", fields: ["latitude", "longitude"] },
];

/** Human copy for each non-measured verdict, mirrored from `field_status_legend`. */
export const STATUS_COPY: Record<FieldStatus, { short: string; detail: string }> = {
  measured: { short: "LIVE", detail: "Value present and passed schema validation." },
  absent_upstream: { short: "AWAITING UPSTREAM", detail: "The upstream API never sent this key. Quarantined as NULL by the data layer -- not a zero." },
  null_upstream: { short: "NO READING", detail: "The key arrived with a null/empty value. Stored NULL by the data layer -- not a zero." },
  field_error: { short: "REJECTED", detail: "The value failed a range/type gate and was stored NULL. See the field error detail." },
};

/* --------------------------------------------------------------- selectors */

/** All 24 parameters in spec order, with the data layer's own health metadata. */
export function orderedParams(doc: TrustedTelemetryDocument): ParameterHealth[] {
  const byField = new Map<string, ParameterHealth>();
  for (const p of [...doc.pipeline_health.available_parameters, ...doc.pipeline_health.unavailable_parameters]) {
    byField.set(p.field, p);
  }
  return PARAM_ORDER.map((field) => {
    const declared = byField.get(field) ?? {
      field,
      label: field,
      unit: "",
      logical_type: "float",
      documented_upstream: false,
      vehicles_with_value: 0,
      coverage_pct: 0,
      status: "unavailable_upstream" as const,
      status_breakdown: {},
    };
    // The contract outranks the document: a field the upstream does not measure
    // is unavailable even if this particular file failed to say so.
    return isUnmeasured(field) ? { ...declared, status: "unavailable_upstream" as const } : declared;
  });
}

/** The single gate every tile uses to decide "live" vs "disabled". */
export function isMeasured(vehicle: TrustedVehicle, field: string): boolean {
  if (isUnmeasured(field)) return false; // pinned disabled; the value is NULL by contract
  return vehicle.field_status[field] === "measured";
}

/** A number, or null.  Never coerces "" / undefined / NaN into 0, and never
 *  returns a reading for one of the 9 unmeasured parameters. */
export function numericValue(vehicle: TrustedVehicle, field: string): number | null {
  if (isUnmeasured(field)) return null;
  const v = vehicle.values[field];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface FleetSummary {
  assets: number;
  accepted: number;
  quarantined: number;
  completenessPct: number;
  liveParams: number;
  deadParams: number;
  unavailableFields: string[];
  absentCells: number;
  nullCells: number;
  errorCells: number;
  socMedian: number | null;
  socMin: number | null;
  sohMin: number | null;
  stationary: number;
  lowSoc: number;
  staleOver24h: number;
  medianFrameAgeHours: number;
  oldestFrame: string | null;
  newestFrame: string | null;
  maxCellImbalanceMv: number;
}

export function fleetSummary(doc: TrustedTelemetryDocument, now: Date = new Date()): FleetSummary {
  const vehicles = doc.vehicles;
  const nums = (field: string) =>
    vehicles.map((v) => numericValue(v, field)).filter((v): v is number => v !== null);

  const soc = nums("soc").sort((a, b) => a - b);
  const soh = nums("soh");
  const ages = vehicles
    .map((v) => (v.observed_at ? frameAgeHours(v.observed_at, now) : null))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);

  const imbalances = vehicles
    .map((v) => {
      const lo = numericValue(v, "min_cell_v");
      const hi = numericValue(v, "max_cell_v");
      return lo !== null && hi !== null ? (hi - lo) * 1000 : 0;
    })
    .sort((a, b) => a - b);

  const tally = { absent_upstream: 0, null_upstream: 0, field_error: 0, measured: 0 };
  for (const v of vehicles) {
    for (const status of Object.values(v.field_status)) tally[status] += 1;
  }

  return {
    assets: vehicles.length,
    accepted: doc.pipeline_health.vehicles_accepted,
    quarantined: doc.pipeline_health.vehicles_quarantined,
    completenessPct: doc.pipeline_health.fleet_completeness_pct,
    liveParams: doc.pipeline_health.parameters_available,
    deadParams: doc.pipeline_health.parameters_unavailable_upstream,
    unavailableFields: doc.pipeline_health.unavailable_parameters.map((p) => p.field),
    absentCells: tally.absent_upstream,
    nullCells: tally.null_upstream,
    errorCells: tally.field_error,
    socMedian: soc.length ? soc[Math.floor(soc.length / 2)] : null,
    socMin: soc.length ? soc[0] : null,
    sohMin: soh.length ? Math.min(...soh) : null,
    stationary: vehicles.filter((v) => numericValue(v, "speed_kmh") === 0).length,
    lowSoc: soc.filter((s) => s < 20).length,
    staleOver24h: ages.filter((a) => a > 24).length,
    medianFrameAgeHours: ages.length ? ages[Math.floor(ages.length / 2)] : 0,
    oldestFrame: doc.pipeline_health.oldest_observed_at,
    newestFrame: doc.pipeline_health.newest_observed_at,
    maxCellImbalanceMv: imbalances.length ? Math.round(imbalances[imbalances.length - 1]) : 0,
  };
}

export function frameAgeHours(iso: string, now: Date = new Date()): number {
  const then = Date.parse(iso);
  return Number.isFinite(then) ? (now.getTime() - then) / 3_600_000 : Number.NaN;
}

export function formatAge(hours: number): string {
  if (!Number.isFinite(hours)) return "unknown";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours / 24)} d`;
}

/** Display a validated value.  `null` must never become "0" -- callers render
 *  the unavailable state instead; this returns null so they can branch. */
export function formatValue(value: ParamValue, unit: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    const abs = Math.abs(value);
    const text = abs >= 1000 ? value.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
    return unit ? `${text} ${unit}` : text;
  }
  return String(value);
}

/* ------------------------------------------------------------- geo helpers */

/** Approximate India bounding box, used to keep obvious coordinate faults
 *  (e.g. a module's factory-default reading) off the density surface. */
export const INDIA_BBOX = { latMin: 6, latMax: 37, lonMin: 68, lonMax: 98 } as const;

/** Reference cities for labelling clusters.  Real coordinates, no geometry is
 *  invented: the map draws a graticule plus these anchors, not fake borders. */
export const REFERENCE_CITIES: ReadonlyArray<{ name: string; state: string; lat: number; lon: number }> = [
  { name: "Mumbai", state: "Maharashtra", lat: 19.076, lon: 72.8777 },
  { name: "Pune", state: "Maharashtra", lat: 18.5204, lon: 73.8567 },
  { name: "Nashik", state: "Maharashtra", lat: 19.9975, lon: 73.7898 },
  { name: "Panaji", state: "Goa", lat: 15.4909, lon: 73.8278 },
  { name: "Surat", state: "Gujarat", lat: 21.1702, lon: 72.8311 },
  { name: "Ahmedabad", state: "Gujarat", lat: 23.0225, lon: 72.5714 },
  { name: "Udaipur", state: "Rajasthan", lat: 24.585, lon: 73.7125 },
  { name: "Kota", state: "Rajasthan", lat: 25.2138, lon: 75.8648 },
  { name: "Jaipur", state: "Rajasthan", lat: 26.9124, lon: 75.7873 },
  { name: "Delhi NCR", state: "Delhi", lat: 28.6139, lon: 77.209 },
  { name: "Indore", state: "Madhya Pradesh", lat: 22.7196, lon: 75.8577 },
  { name: "Bhopal", state: "Madhya Pradesh", lat: 23.2599, lon: 77.4126 },
  { name: "Nagpur", state: "Maharashtra", lat: 21.1458, lon: 79.0882 },
  { name: "Raipur", state: "Chhattisgarh", lat: 21.2514, lon: 81.6296 },
  { name: "Raurkela", state: "Odisha", lat: 22.2601, lon: 84.83 },
  { name: "Bhubaneswar", state: "Odisha", lat: 20.2961, lon: 85.8245 },
  { name: "Kolkata", state: "West Bengal", lat: 22.5726, lon: 88.3639 },
  { name: "Hyderabad", state: "Telangana", lat: 17.385, lon: 78.4867 },
  { name: "Vijayawada", state: "Andhra Pradesh", lat: 16.5062, lon: 80.648 },
  { name: "Visakhapatnam", state: "Andhra Pradesh", lat: 17.6868, lon: 83.2185 },
  { name: "Chennai", state: "Tamil Nadu", lat: 13.0827, lon: 80.2707 },
  { name: "Bengaluru", state: "Karnataka", lat: 12.9716, lon: 77.5946 },
  { name: "Kochi", state: "Kerala", lat: 9.9312, lon: 76.2673 },
];

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function nearestCity(lat: number, lon: number) {
  let best = REFERENCE_CITIES[0];
  let bestKm = Number.POSITIVE_INFINITY;
  for (const city of REFERENCE_CITIES) {
    const km = haversineKm(lat, lon, city.lat, city.lon);
    if (km < bestKm) {
      best = city;
      bestKm = km;
    }
  }
  return { name: best.name, state: best.state, distanceKm: Math.round(bestKm) };
}

export interface GeoPoint {
  vehicleId: string;
  lat: number;
  lon: number;
  soc: number | null;
  speedKmh: number | null;
  observedAt: string | null;
  completenessPct: number;
}

export interface Cluster {
  id: string;
  /** Centroid of the members, not the grid corner. */
  lat: number;
  lon: number;
  count: number;
  members: GeoPoint[];
  city: { name: string; state: string; distanceKm: number };
  avgSoc: number | null;
}

/** Extract GPS-bearing frames.  A vehicle whose latitude/longitude is not
 *  "measured" is dropped here -- it is listed by the caller as unlocatable
 *  rather than plotted at (0, 0). */
export function geoPoints(vehicles: TrustedVehicle[]): { points: GeoPoint[]; unlocatable: string[] } {
  const points: GeoPoint[] = [];
  const unlocatable: string[] = [];
  for (const v of vehicles) {
    const lat = numericValue(v, "latitude");
    const lon = numericValue(v, "longitude");
    if (lat === null || lon === null) {
      unlocatable.push(v.vehicle_id);
      continue;
    }
    points.push({
      vehicleId: v.vehicle_id,
      lat,
      lon,
      soc: numericValue(v, "soc"),
      speedKmh: numericValue(v, "speed_kmh"),
      observedAt: v.observed_at,
      completenessPct: v.completeness_pct,
    });
  }
  return { points, unlocatable };
}

/** Fixed-grid clustering.  `cellDeg` 0.25 ~= a 25 km cell, which is the right
 *  granularity for "where would a charger serve the most trucks". */
export function buildClusters(points: GeoPoint[], cellDeg = 0.25): Cluster[] {
  const cells = new Map<string, GeoPoint[]>();
  for (const p of points) {
    const key = `${Math.round(p.lat / cellDeg)}:${Math.round(p.lon / cellDeg)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(p);
    else cells.set(key, [p]);
  }

  const clusters: Cluster[] = [];
  for (const [key, members] of cells) {
    const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
    const socs = members.map((m) => m.soc).filter((s): s is number => s !== null);
    clusters.push({
      id: key,
      lat,
      lon,
      count: members.length,
      members,
      city: nearestCity(lat, lon),
      avgSoc: socs.length ? Math.round(socs.reduce((s, v) => s + v, 0) / socs.length) : null,
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}
