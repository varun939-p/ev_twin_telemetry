/**
 * In-house analytical report generators — the replacement for the external EMS
 * exports (Kazam / Analog / Om Energy / Day Cloud / Solis / Noark / Battery
 * Smart / Baz).  Pure and React-free; the Recharts components in
 * `components/battery/BatteryAnalytics` render whatever these return.
 *
 * Every generator projects the SAME validated document, so a chart can never
 * disagree with the table above it.  Frames missing either axis are dropped
 * and counted in `excluded` — an unmeasured value is never plotted as 0,
 * which would bend a regression line towards a reading that does not exist.
 */

import { numericValue, type TrustedVehicle } from "@/lib/trusted-telemetry";
import type { BatteryIdentity } from "@/lib/fleet";

export type ReportId = "cycles-vs-time" | "mileage-vs-soc" | "soh-vs-soc";

export interface ReportPoint {
  x: number;
  y: number;
  /** Frame id — the deep-link key. */
  id: string;
  /** "Battery 12" */
  label: string;
  /** Extra context for the tooltip. */
  meta: string;
}

export interface ReportSeries {
  id: ReportId;
  title: string;
  subtitle: string;
  xKey: string;
  yKey: string;
  xLabel: string;
  yLabel: string;
  xType: "time" | "number";
  points: ReportPoint[];
  /** Least-squares fit over the plotted points, or null with < 2 points. */
  trend: { from: { x: number; y: number }; to: { x: number; y: number }; slope: number; r2: number } | null;
  /** Frames dropped because one of the two axes was not measured. */
  excluded: number;
  /** Honest description of what the chart can and cannot claim. */
  provenance: string;
}

export const REPORTS: ReadonlyArray<{ id: ReportId; label: string; blurb: string }> = [
  { id: "cycles-vs-time", label: "Charge Cycles vs Time", blurb: "Cumulative cycle count against the frame timestamp" },
  { id: "mileage-vs-soc", label: "Mileage vs SOC", blurb: "Delivered range against state of charge" },
  { id: "soh-vs-soc", label: "SOH vs SOC", blurb: "Degradation against current charge level" },
];

/** Ordinary least squares. Returns null when the fit is undefined. */
function leastSquares(points: ReportPoint[]): ReportSeries["trend"] {
  if (points.length < 2) return null;
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = my - slope * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    ssRes += (p.y - (slope * p.x + intercept)) ** 2;
    ssTot += (p.y - my) ** 2;
  }

  const xs = points.map((p) => p.x);
  const from = Math.min(...xs);
  const to = Math.max(...xs);
  return {
    from: { x: from, y: slope * from + intercept },
    to: { x: to, y: slope * to + intercept },
    slope,
    r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
  };
}

/** `mileage-vs-soc` can plot either mileage channel. */
export type MileageChannel = "residual_mileage_km" | "odometer_km";

export interface ReportOptions {
  mileageChannel?: MileageChannel;
}

export function buildReport(
  id: ReportId,
  vehicles: TrustedVehicle[],
  registry: ReadonlyMap<string, BatteryIdentity>,
  options: ReportOptions = {},
): ReportSeries {
  const label = (v: TrustedVehicle) => registry.get(v.vehicle_id)?.label ?? v.vehicle_id;
  const points: ReportPoint[] = [];
  let excluded = 0;

  if (id === "cycles-vs-time") {
    for (const v of vehicles) {
      const cycles = numericValue(v, "charge_cycles");
      const t = v.observed_at ? Date.parse(v.observed_at) : Number.NaN;
      if (cycles === null || !Number.isFinite(t)) {
        excluded += 1;
        continue;
      }
      points.push({
        x: t,
        y: cycles,
        id: v.vehicle_id,
        label: label(v),
        meta: `SOH ${numericValue(v, "soh") ?? "—"}% · SOC ${numericValue(v, "soc") ?? "—"}%`,
      });
    }
    points.sort((a, b) => a.x - b.x);
    return {
      id,
      title: "Charge Cycles vs Time",
      subtitle: "One point per pack, positioned at the timestamp of its last validated frame",
      xKey: "x",
      yKey: "y",
      xLabel: "Observation time (IST)",
      yLabel: "Charge cycles",
      xType: "time",
      points,
      trend: leastSquares(points),
      excluded,
      provenance:
        "Cycle counts are cumulative ECU counters; the trend is a cross-sectional fit over the fleet's latest frames, not a per-pack time series. Wire the `telemetry` history table in for a true per-pack curve.",
    };
  }

  if (id === "mileage-vs-soc") {
    const channel: MileageChannel = options.mileageChannel ?? "residual_mileage_km";
    for (const v of vehicles) {
      const soc = numericValue(v, "soc");
      const km = numericValue(v, channel);
      if (soc === null || km === null) {
        excluded += 1;
        continue;
      }
      points.push({
        x: soc,
        y: km,
        id: v.vehicle_id,
        label: label(v),
        meta: `${numericValue(v, "charge_cycles") ?? "—"} cycles · SOH ${numericValue(v, "soh") ?? "—"}%`,
      });
    }
    points.sort((a, b) => a.x - b.x);
    return {
      id,
      title: channel === "residual_mileage_km" ? "Residual Mileage vs SOC" : "Odometer vs SOC",
      subtitle:
        channel === "residual_mileage_km"
          ? "Range still available against the charge that has to deliver it"
          : "Lifetime distance against the pack's current charge level",
      xKey: "x",
      yKey: "y",
      xLabel: "State of charge (%)",
      yLabel: channel === "residual_mileage_km" ? "Residual mileage (km)" : "Odometer (km)",
      xType: "number",
      points,
      trend: leastSquares(points),
      excluded,
      provenance:
        channel === "residual_mileage_km"
          ? "Residual mileage is the ECU's own range estimate, not a derived figure — the slope is the fleet's realised km per SOC point."
          : "Odometer is a monotonic counter guarded by the anti-regression upsert in the data layer.",
    };
  }

  for (const v of vehicles) {
    const soc = numericValue(v, "soc");
    const soh = numericValue(v, "soh");
    if (soc === null || soh === null) {
      excluded += 1;
      continue;
    }
    points.push({
      x: soc,
      y: soh,
      id: v.vehicle_id,
      label: label(v),
      meta: `${numericValue(v, "charge_cycles") ?? "—"} cycles · ${numericValue(v, "odometer_km") ?? "—"} km`,
    });
  }
  points.sort((a, b) => a.x - b.x);
  return {
    id: "soh-vs-soc",
    title: "State of Health vs State of Charge",
    subtitle: "Degradation spread across the charge band — outliers below the fleet floor are the swap candidates",
    xKey: "x",
    yKey: "y",
    xLabel: "State of charge (%)",
    yLabel: "State of health (%)",
    xType: "number",
    points,
    trend: leastSquares(points),
    excluded,
    provenance:
      "SOH and SOC are independent ECU channels; a flat fit is the expected result for a healthy fleet — a negative slope means low-charge packs are also the degraded ones.",
  };
}

/** Client-side CSV of exactly what is plotted — the EMS export, in-house. */
export function seriesToCsv(series: ReportSeries): string {
  const header = ["battery_id", "frame_id", series.xLabel, series.yLabel, "context"];
  const rows = series.points.map((p) => [
    p.label,
    p.id,
    series.xType === "time" ? new Date(p.x).toISOString() : String(p.x),
    String(p.y),
    p.meta,
  ]);
  return [header, ...rows]
    .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}
