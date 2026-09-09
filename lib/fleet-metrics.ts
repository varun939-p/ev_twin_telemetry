/**
 * Fleet metric reducers + the anomaly (\"Need Attention\") engine.
 *
 * Pure, React-free, and bound by the same hard rule as the rest of `lib/`:
 * a parameter that the upstream did not measure yields `null`, never `0`.
 * Every roll-up below therefore returns BOTH a value and its coverage, so the
 * UI can render "awaiting upstream" instead of a confident, wrong number.
 *
 * This is the layer that replaces the third-party EMS read-outs (Kazam /
 * Analog / Om Energy / Day Cloud / Solis / Noark / Battery Smart / Baz): all
 * of it is computed in-house from the validated document.
 */

import {
  batterySlot,
  isEvVehicle,
  nearestStation,
  predictArrival,
  truckChassis,
  vehicleCity,
  vehicleGeo,
  type BatteryIdentity,
  type SwapStation,
} from "@/lib/fleet";
import {
  frameAgeHours,
  isMeasured,
  numericValue,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";

/* ------------------------------------------------------------- live status */

export type AssetStatus = "moving" | "charging" | "idle" | "stopped" | "unknown";

export const STATUS_LABEL: Record<AssetStatus, string> = {
  moving: "In service · moving / run",
  charging: "Charging",
  idle: "Idle · ready",
  stopped: "Stopped",
  unknown: "Other / offline · no motion reading",
};

export const STATUS_SHORT: Record<AssetStatus, string> = {
  moving: "Active",
  charging: "Charging",
  idle: "Idle",
  stopped: "Stopped",
  unknown: "Unknown",
};

/** Token names, not hex: the map, tables and canvas all read the same set so
 *  a status can never mean two different colours in two places. */
export const STATUS_TOKEN: Record<AssetStatus, "ok" | "accent" | "warn" | "ink-3"> = {
  moving: "ok",
  charging: "accent",
  idle: "warn",
  stopped: "ink-3",
  unknown: "ink-3",
};

/**
 * Live state of one frame.
 *
 * Integrated with Blue Energy operating code dictionary:
 * - workst: 0 Init, 1 Ready-Green, 2 Start, 3 Run/Working, 4 Stop
 * - chg_status: 0 Not charging, 1 Charging
 * - status(card): Active, Charging, Idle, Stopped, Unknown
 *
 * Precedence:
 * 1. charging_status === 1 => "charging" (Charging)
 * 2. work_status === "4" => "stopped" (Stopped)
 * 3. speed > 0 or work_status === "3" => "moving" (Active)
 * 4. speed === 0 or work_status in ("0", "1", "2") => "idle" (Idle)
 * 5. otherwise => "unknown" (Unknown)
 */
export function assetStatus(vehicle: TrustedVehicle): AssetStatus {
  if (numericValue(vehicle, "charging_status") === 1) return "charging";
  const workSt =
    vehicle.values.work_status !== null && vehicle.values.work_status !== undefined
      ? String(vehicle.values.work_status).trim()
      : null;
  if (workSt === "4") return "stopped";
  const speed = numericValue(vehicle, "speed_kmh");
  if (speed !== null && speed > 0) return "moving";
  if (workSt === "3") return "moving";
  if (speed === 0 || (workSt !== null && ["0", "1", "2"].includes(workSt))) return "idle";
  if (speed === null && workSt === null) return "unknown";
  return "idle";
}

/* --------------------------------------------------------- power + energy */

/**
 * Instantaneous DC power draw of one pack, in kW.
 *
 * P = |V x I| / 1000, from the two measured pack channels.  Returns `null`
 * when either channel is absent upstream -- the caller must not substitute 0,
 * because a pack drawing an unknown current is not a pack drawing nothing.
 */
export function packPowerDrawKw(vehicle: TrustedVehicle): number | null {
  const volts = numericValue(vehicle, "battery_total_v");
  const amps = numericValue(vehicle, "battery_current_a");
  if (volts === null || amps === null) return null;
  return Math.abs(volts * amps) / 1000;
}

/** Tri-state charging verdict: true / false / null (channel not measured). */
export function isCharging(vehicle: TrustedVehicle): boolean | null {
  if (!isMeasured(vehicle, "charging_status")) return null;
  return numericValue(vehicle, "charging_status") === 1;
}

export interface CoveredMetric<T> {
  /** The value, or null when no frame in scope measured the inputs. */
  value: T | null;
  /** How many frames contributed a measured reading. */
  measuredFrames: number;
  /** How many frames were in scope at all. */
  totalFrames: number;
  /** Human explanation for the "awaiting upstream" state. */
  note: string;
}

/**
 * Packs actively on a charger.
 *
 * Spec: `Batteries Charging Right Now`.  Implemented as a strict count of
 * frames whose `charging_status` is MEASURED and equal to 1.  With today's
 * two-tier v1 feed the channel is absent on every frame, so `value` is null
 * and the KPI card renders "awaiting upstream" -- it will start counting the
 * moment the backend provisions `chg_status`, with no UI change.
 */
export function chargingNow(vehicles: TrustedVehicle[]): CoveredMetric<number> {
  const measured = vehicles.filter((v) => isMeasured(v, "charging_status"));
  const active = measured.filter((v) => numericValue(v, "charging_status") === 1);
  return {
    value: measured.length === 0 ? null : active.length,
    measuredFrames: measured.length,
    totalFrames: vehicles.length,
    note:
      measured.length === 0
        ? "charging_status is absent on every frame in scope — the upstream v1 feed has not provisioned this channel yet."
        : `${measured.length} of ${vehicles.length} frames report a charger state.`,
  };
}

/**
 * Current running load in kW.
 *
 *     Total Load (kW) = Σ (active charging packs × instantaneous power draw)
 *
 * "Active charging pack" = `charging_status` measured AND == 1.
 * "Instantaneous power draw" = |V x I| / 1000 from the measured pack channels.
 * A pack that is charging but whose V/I channels are absent contributes
 * nothing to the sum and is counted in `unmeasuredContributors`, so the tile
 * can say "partial" instead of quietly under-reporting.
 */
export interface RunningLoad extends CoveredMetric<number> {
  activePacks: number;
  unmeasuredContributors: number;
}

export function runningLoadKw(vehicles: TrustedVehicle[]): RunningLoad {
  let sum = 0;
  let contributors = 0;
  let unmeasured = 0;
  let active = 0;

  for (const v of vehicles) {
    if (isCharging(v) !== true) continue;
    active += 1;
    const kw = packPowerDrawKw(v);
    if (kw === null) unmeasured += 1;
    else {
      sum += kw;
      contributors += 1;
    }
  }

  return {
    value: contributors === 0 ? null : Math.round(sum * 10) / 10,
    activePacks: active,
    unmeasuredContributors: unmeasured,
    measuredFrames: contributors,
    totalFrames: vehicles.length,
    note:
      contributors === 0
        ? "Σ(active packs × V×I) needs charging_status + battery_total_v + battery_current_a; none are measured in this scope."
        : `Σ over ${contributors} charging pack${contributors === 1 ? "" : "s"} with measured V and I${
            unmeasured ? ` · ${unmeasured} charging pack(s) missing V/I` : ""
          }.`,
  };
}

/** Packs mounted on a truck that is currently moving = deployed / in service. */
export function deployedPacks(vehicles: TrustedVehicle[]): CoveredMetric<number> {
  const packs = vehicles.filter(isEvVehicle);
  const measured = packs.filter((v) => isMeasured(v, "speed_kmh"));
  const moving = measured.filter((v) => (numericValue(v, "speed_kmh") ?? 0) > 0);
  return {
    value: measured.length === 0 ? null : moving.length,
    measuredFrames: measured.length,
    totalFrames: packs.length,
    note:
      measured.length === 0
        ? "speed_kmh is not measured in this scope."
        : `${moving.length} pack${moving.length === 1 ? "" : "s"} on a moving carrier · ${
            measured.length - moving.length
          } stationary.`,
  };
}

/** Median age of the newest validated frame per asset, in hours. */
export function medianFrameAgeHours(vehicles: TrustedVehicle[], now: Date = new Date()): number | null {
  const ages = vehicles
    .map((v) => (v.observed_at ? frameAgeHours(v.observed_at, now) : null))
    .filter((a): a is number => a !== null && Number.isFinite(a))
    .sort((a, b) => a - b);
  return ages.length ? ages[Math.floor(ages.length / 2)] : null;
}

/* ------------------------------------------------------------------ alerts */

export type AlertSeverity = "critical" | "warning" | "info";
export type AlertScope = "battery" | "truck";

/**
 * Alert taxonomy. Every alert carries its kind so the banner can COLLAPSE
 * repeats: a fleet whose whole feed is 40 h old produces ~90 identical
 * "stale telemetry" rows, and an operator scrolling 90 rows is an operator
 * who stops reading the banner. One group header + the worst three rows +
 * "show all" keeps the panel triageable at any fleet size.
 */
/**
 * Alert taxonomy, STRICTLY partitioned by scope.
 *
 *   BATTERY page  soc-critical | soc-low | soh | thermal | field-error
 *   TRUCK page    stale | no-fix | range | completeness
 *
 * The partition is the point. `stale` used to be raised by BOTH producers, so
 * the same ~98 rows appeared on both pages and buried the handful of
 * pack-specific items an operator actually needs to act on. Staleness is a
 * property of the TELEMETRY LINK to a carrier, not of a battery, so it now
 * lives only on Truck Telemetry. Nothing is lost — it moved.
 */
export type AlertKind =
  // battery-scoped
  | "soc-critical"
  | "soc-low"
  | "soh"
  | "thermal"
  | "field-error"
  // carrier-scoped
  | "stale"
  | "no-fix"
  | "range"
  | "completeness";

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  "soc-critical": "Below dispatch reserve",
  "soc-low": "Approaching reserve",
  soh: "Degraded state of health",
  thermal: "Pack temperature",
  "field-error": "Rejected readings",
  stale: "Stale telemetry",
  "no-fix": "No GPS fix",
  range: "Range shortfall to hub",
  completeness: "Sparse parameter coverage",
};

export interface TwinAlert {
  id: string;
  kind: AlertKind;
  scope: AlertScope;
  severity: AlertSeverity;
  vehicleId: string;
  /** Display name: "Battery 7" for packs, the chassis for carriers. */
  label: string;
  /** One-line headline shown in the banner row. */
  title: string;
  /** Contextual comment surfaced in the hover tooltip. */
  comment: string;
  /** Optional metric badge, e.g. "SOC 14%". */
  metric?: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Reserve threshold below which a pack is operationally unhealthy. */
export const SOC_CRITICAL = 20;
export const SOC_LOW = 35;
export const SOH_DEGRADED = 90;
export const STALE_HOURS = 24;
/** Pack thermal thresholds (°C). Watch band, then hard limit. */
export const TEMP_WARN_C = 45;
export const TEMP_CRITICAL_C = 55;

function ageComment(vehicle: TrustedVehicle, now: Date): string {
  if (!vehicle.observed_at) return "No observation timestamp on the last validated frame.";
  const hours = frameAgeHours(vehicle.observed_at, now);
  if (!Number.isFinite(hours)) return "Observation timestamp could not be parsed.";
  if (hours < 1) return `Last validated frame ${Math.max(1, Math.round(hours * 60))} min ago.`;
  if (hours < 48) return `Last validated frame ${hours.toFixed(1)} h ago.`;
  return `Last validated frame ${Math.round(hours / 24)} d ago.`;
}

/**
 * Battery-only anomalies for the Battery Tracking banner.
 *
 * NOTE on rate-of-change comments ("dropped 1% SOC within X"): a delta needs
 * two frames, and this document is a single validated snapshot per asset.
 * The comment therefore reports the *evidence we actually hold* -- current
 * SOC, the reserve threshold it breached and the age of the frame that said
 * so.  Wire `telemetry.repository` history into a `/api/telemetry/history`
 * route and `socDelta` below starts filling in the drop-rate sentence.
 */
export function batteryAlerts(
  vehicles: TrustedVehicle[],
  registry: ReadonlyMap<string, BatteryIdentity>,
  sites: readonly SwapStation[],
  now: Date = new Date(),
): TwinAlert[] {
  const alerts: TwinAlert[] = [];

  for (const v of vehicles) {
    if (!isEvVehicle(v)) continue;
    const label = registry.get(v.vehicle_id)?.label ?? v.vehicle_id;
    const soc = numericValue(v, "soc");
    const soh = numericValue(v, "soh");
    const age = ageComment(v, now);

    if (soc !== null && soc < SOC_CRITICAL) {
      alerts.push({
        id: `${v.vehicle_id}:soc-critical`,
        kind: "soc-critical",
        scope: "battery",
        severity: "critical",
        vehicleId: v.vehicle_id,
        label,
        title: `${label} is below the ${SOC_CRITICAL}% reserve`,
        comment: `SOC ${soc}% — under the ${SOC_CRITICAL}% dispatch reserve on carrier ${truckChassis(
          v.vehicle_id,
        )}. ${age} Route to the nearest hub before the next leg.`,
        metric: `SOC ${soc}%`,
      });
    } else if (soc !== null && soc < SOC_LOW) {
      alerts.push({
        id: `${v.vehicle_id}:soc-low`,
        kind: "soc-low",
        scope: "battery",
        severity: "warning",
        vehicleId: v.vehicle_id,
        label,
        title: `${label} approaching reserve`,
        comment: `SOC ${soc}% — inside the ${SOC_LOW}% watch band. ${age} Swap capacity should be reserved at ${
          nearestStation(v, sites)?.name ?? "the nearest hub"
        }.`,
        metric: `SOC ${soc}%`,
      });
    }

    if (soh !== null && soh < SOH_DEGRADED) {
      alerts.push({
        id: `${v.vehicle_id}:soh`,
        kind: "soh",
        scope: "battery",
        severity: "warning",
        vehicleId: v.vehicle_id,
        label,
        title: `${label} state of health ${soh}%`,
        comment: `SOH ${soh}% is below the ${SOH_DEGRADED}% fleet floor after ${
          numericValue(v, "charge_cycles") ?? "—"
        } charge cycles. ${age} Flag for a capacity test at the next swap.`,
        metric: `SOH ${soh}%`,
      });
    }

    if (v.field_errors.length > 0) {
      alerts.push({
        id: `${v.vehicle_id}:field-error`,
        kind: "field-error",
        scope: "battery",
        severity: "warning",
        vehicleId: v.vehicle_id,
        label,
        title: `${label} rejected ${v.field_errors.length} reading${v.field_errors.length === 1 ? "" : "s"}`,
        comment: `The validator stored NULL for: ${v.field_errors
          .map((e) => e.field)
          .join(", ")}. Values failed a range/type gate — treat the affected channels as unavailable, not zero.`,
      });
    }

    /**
     * Pack thermal. Dormant today — every thermal channel is absent upstream —
     * and live the moment the vendor provisions one, with no code change,
     * because it reads through `numericValue` and so is gated on the field's
     * `measured` verdict rather than on a hardcoded assumption.
     *
     * `max_temp_c` is preferred over the pack average: a single hot cell group
     * is what precedes a thermal event, and an average hides it.
     */
    const packTemp = numericValue(v, "max_temp_c") ?? numericValue(v, "battery_temp_c");
    if (packTemp !== null && packTemp >= TEMP_WARN_C) {
      const critical = packTemp >= TEMP_CRITICAL_C;
      alerts.push({
        id: `${v.vehicle_id}:thermal`,
        kind: "thermal",
        scope: "battery",
        severity: critical ? "critical" : "warning",
        vehicleId: v.vehicle_id,
        label,
        title: critical
          ? `${label} pack temperature is critical`
          : `${label} pack running warm`,
        comment: `Peak cell-group temperature ${packTemp} °C — ${
          critical
            ? `at or above the ${TEMP_CRITICAL_C} °C limit. Take the pack out of service and inspect before the next charge.`
            : `above the ${TEMP_WARN_C} °C watch threshold. Monitor through the next charge cycle.`
        } ${age}`,
        metric: `${packTemp} °C`,
      });
    }
  }

  return alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Carrier-only anomalies, moved wholesale onto Truck Telemetry.
 * Pack chemistry lives on the Battery page; this list is about the vehicle:
 * where it is, whether we can hear it, and whether it can reach a hub.
 */
export function truckAlerts(
  vehicles: TrustedVehicle[],
  sites: readonly SwapStation[],
  now: Date = new Date(),
): TwinAlert[] {
  const alerts: TwinAlert[] = [];

  for (const v of vehicles) {
    const label = truckChassis(v.vehicle_id);
    const age = ageComment(v, now);

    const hasFix = vehicleGeo(v) !== null;
    if (!hasFix) {
      alerts.push({
        id: `${v.vehicle_id}:no-fix`,
        kind: "no-fix",
        scope: "truck",
        severity: "critical",
        vehicleId: v.vehicle_id,
        label,
        title: `${label} has no GPS fix`,
        comment: `latitude/longitude are not measured on the last validated frame, so this carrier cannot be plotted. ${age} It is listed here rather than pinned at (0, 0).`,
      });
    }

    const hours = v.observed_at ? frameAgeHours(v.observed_at, now) : Number.NaN;
    if (Number.isFinite(hours) && hours > STALE_HOURS) {
      alerts.push({
        id: `${v.vehicle_id}:stale`,
        kind: "stale",
        scope: "truck",
        severity: hours > STALE_HOURS * 7 ? "critical" : "warning",
        vehicleId: v.vehicle_id,
        label,
        title: `${label} has not reported in ${hours > 48 ? `${Math.round(hours / 24)} days` : `${hours.toFixed(1)} h`}`,
        comment: `${age} Position, SOC and odometer on this row are the last trusted values — treat them as historical.`,
        metric: `${v.measured_count}/24 params`,
      });
    }

    if (isEvVehicle(v)) {
      /**
       * RANGE SHORTFALL — deliberately narrow.
       *
       * A naive "range < distance to nearest hub" test flags most of a parked
       * fleet: a depot truck 900 km from a hub is not stranded, it is simply
       * not going there. Two gates keep this alert actionable:
       *   1. the carrier must be MOVING (`speed_kmh > 0`) — only then is it
       *      committed to a leg it may not finish;
       *   2. the frame must be FRESH — a range figure from a 10-day-old frame
       *      says nothing about where the truck is now, and the staleness
       *      alert above already covers that case.
       */
      const moving = (numericValue(v, "speed_kmh") ?? 0) > 0;
      const fresh = Number.isFinite(hours) && hours <= STALE_HOURS;
      const arrival = predictArrival(v, sites);
      if (moving && fresh && arrival.rangeKm !== null && arrival.distanceKm !== null && !arrival.feasible) {
        alerts.push({
          id: `${v.vehicle_id}:range`,
        kind: "range",
          scope: "truck",
          severity: "critical",
          vehicleId: v.vehicle_id,
          label,
          title: `${label} cannot reach ${arrival.station?.name ?? "a hub"}`,
          comment: `Estimated remaining range ${arrival.rangeKm} km vs ${arrival.distanceKm} km to ${
            arrival.station?.name ?? "the nearest hub"
          }. Shortfall ${arrival.distanceKm - arrival.rangeKm} km — dispatch a swap van or re-route.`,
          metric: `${arrival.rangeKm} / ${arrival.distanceKm} km`,
        });
      }
    }

    if (v.completeness_pct < 20) {
      alerts.push({
        id: `${v.vehicle_id}:completeness`,
        kind: "completeness",
        scope: "truck",
        severity: "info",
        vehicleId: v.vehicle_id,
        label,
        title: `${label} is reporting ${v.measured_count} of 24 parameters`,
        comment: `Completeness ${v.completeness_pct}%. Missing channels: ${
          v.missing_fields.slice(0, 6).join(", ") || "none"
        }${v.missing_fields.length > 6 ? `, +${v.missing_fields.length - 6} more` : ""}.`,
        metric: `${v.completeness_pct}%`,
      });
    }
  }

  return alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/* ------------------------------------------------------- table projections */

/** The 6 vital fields the truck table shows before [Know More]. */
export interface TruckRow {
  vehicleId: string;
  chassis: string;
  isEv: boolean;
  status: AssetStatus;
  soc: number | null;
  residualKm: number | null;
  odometerKm: number | null;
  speedKmh: number | null;
  batteryLabel: string | null;
  place: { name: string; state: string } | null;
  observedAt: string | null;
  measuredCount: number;
  vehicle: TrustedVehicle;
}

export function truckRows(
  vehicles: TrustedVehicle[],
  registry: ReadonlyMap<string, BatteryIdentity>,
): TruckRow[] {
  return vehicles.map((v) => ({
    vehicleId: v.vehicle_id,
    chassis: truckChassis(v.vehicle_id),
    isEv: isEvVehicle(v),
    status: assetStatus(v),
    soc: numericValue(v, "soc"),
    residualKm: numericValue(v, "residual_mileage_km"),
    odometerKm: numericValue(v, "odometer_km"),
    speedKmh: numericValue(v, "speed_kmh"),
    batteryLabel: registry.get(v.vehicle_id)?.label ?? null,
    place: vehicleCity(v),
    observedAt: v.observed_at,
    measuredCount: v.measured_count,
    vehicle: v,
  }));
}

export interface BatteryRow {
  /** Stable key = the frame id; also what deep links carry. */
  vehicleId: string;
  batteryId: string;
  carrierId: string;
  slot: number | null;
  soc: number | null;
  soh: number | null;
  cycles: number | null;
  odometerKm: number | null;
  status: AssetStatus;
  powerKw: number | null;
  station: { id: string; name: string; distanceKm: number } | null;
  place: { name: string; state: string } | null;
  observedAt: string | null;
  vehicle: TrustedVehicle;
}

export function batteryRows(
  vehicles: TrustedVehicle[],
  registry: ReadonlyMap<string, BatteryIdentity>,
  sites: readonly SwapStation[],
): BatteryRow[] {
  return vehicles
    .filter(isEvVehicle)
    .map((v) => {
      const station = nearestStation(v, sites);
      return {
        vehicleId: v.vehicle_id,
        batteryId: registry.get(v.vehicle_id)?.label ?? v.vehicle_id,
        carrierId: truckChassis(v.vehicle_id),
        slot: batterySlot(v.vehicle_id),
        soc: numericValue(v, "soc"),
        soh: numericValue(v, "soh"),
        cycles: numericValue(v, "charge_cycles"),
        odometerKm: numericValue(v, "odometer_km"),
        status: assetStatus(v),
        powerKw: packPowerDrawKw(v),
        station: station ? { id: station.id, name: station.name, distanceKm: station.distanceKm } : null,
        place: vehicleCity(v),
        observedAt: v.observed_at,
        vehicle: v,
      };
    })
    .sort((a, b) => {
      const an = Number(a.batteryId.replace(/\D+/g, ""));
      const bn = Number(b.batteryId.replace(/\D+/g, ""));
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
      return a.batteryId.localeCompare(b.batteryId);
    });
}
