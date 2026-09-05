"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { GhostButton, SegmentedControl } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline } from "@/components/ui/Surface";
import { REPORTS, buildReport, seriesToCsv, type MileageChannel, type ReportId } from "@/lib/analytics";
import type { BatteryIdentity } from "@/lib/fleet";
import { SOC_CRITICAL } from "@/lib/fleet-metrics";
import { useTwin } from "@/lib/store";
import type { TrustedVehicle } from "@/lib/trusted-telemetry";

/**
 * Analytical report generator — the in-house replacement for third-party EMS
 * charting.
 *
 * Three generators, one projection pipeline (`lib/analytics`):
 *   1. Charge Cycles vs Time
 *   2. Mileage (km) vs SOC (%)      [residual range | odometer]
 *   3. State of Health vs State of Charge
 *
 * Design decisions worth knowing:
 *   * The charts read the SAME filtered scope as the table above them, so a
 *     region filter narrows the regression, not just the rows.
 *   * Frames missing either axis are DROPPED and counted, never plotted as 0 —
 *     a fabricated origin point would drag the least-squares fit.
 *   * The fit line, slope and R² are computed in `lib/analytics` (pure, and
 *     therefore testable) rather than inside a chart callback.
 *   * Colours are CSS custom properties, so a theme flip re-paints the chart
 *     without a re-render.
 *   * Export writes the exact plotted set to CSV, client-side: no server round
 *     trip and no chance of the export disagreeing with the picture.
 */
export default function BatteryAnalytics({
  vehicles,
  registry,
  scopeLabel,
}: {
  vehicles: TrustedVehicle[];
  registry: ReadonlyMap<string, BatteryIdentity>;
  scopeLabel: string;
}) {
  const [reportId, setReportId] = useState<ReportId>("soh-vs-soc");
  const [mileageChannel, setMileageChannel] = useState<MileageChannel>("residual_mileage_km");
  const select = useTwin((s) => s.select);

  const series = useMemo(
    () => buildReport(reportId, vehicles, registry, { mileageChannel }),
    [reportId, vehicles, registry, mileageChannel],
  );

  const formatX = (value: number) =>
    series.xType === "time"
      ? new Date(value).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" })
      : String(Math.round(value));

  const download = () => {
    const blob = new Blob([seriesToCsv(series)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${series.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader
        eyebrow="Report generator"
        title="Battery analytics"
        description={`Generated in-house from the validated document — no external EMS in the path. Scope: ${scopeLabel}.`}
        actions={
          <GhostButton onClick={download} title="Download exactly the plotted points as CSV">
            Export CSV
          </GhostButton>
        }
      />
      <Hairline />

      <div className="flex flex-wrap items-end gap-3 p-4">
        <SegmentedControl<ReportId>
          label="Report"
          value={reportId}
          onChange={setReportId}
          options={REPORTS.map((r) => ({ value: r.id, label: r.label }))}
        />
        {reportId === "mileage-vs-soc" && (
          <SegmentedControl<MileageChannel>
            label="Mileage channel"
            value={mileageChannel}
            onChange={setMileageChannel}
            options={[
              { value: "residual_mileage_km", label: "Residual range" },
              { value: "odometer_km", label: "Odometer" },
            ]}
          />
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Pill tone="neutral">
            n = <span className="num">{series.points.length}</span>
          </Pill>
          {series.excluded > 0 && (
            <Pill tone="warn" title="Frames missing one of the two axes. Excluded rather than plotted as zero.">
              {series.excluded} excluded
            </Pill>
          )}
          {series.trend && (
            <Pill tone="info" title="Ordinary least squares over the plotted points">
              slope <span className="num">{series.trend.slope.toFixed(series.xType === "time" ? 8 : 2)}</span> · R²{" "}
              <span className="num">{series.trend.r2.toFixed(2)}</span>
            </Pill>
          )}
        </div>
      </div>

      <div className="px-2 pb-2">
        <div className="h-[330px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 24, bottom: 34, left: 8 }}>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="x"
                name={series.xLabel}
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatX}
                tick={{ fill: "var(--ink-3)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                stroke="var(--line-strong)"
                label={{
                  value: series.xLabel,
                  position: "insideBottom",
                  offset: -18,
                  fill: "var(--ink-3)",
                  fontSize: 11,
                }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name={series.yLabel}
                domain={["auto", "auto"]}
                tick={{ fill: "var(--ink-3)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                stroke="var(--line-strong)"
                width={56}
                label={{
                  value: series.yLabel,
                  angle: -90,
                  position: "insideLeft",
                  fill: "var(--ink-3)",
                  fontSize: 11,
                  style: { textAnchor: "middle" },
                }}
              />
              <ZAxis range={[46, 46]} />

              {/* Operational threshold, not a decoration: left of this line is
                  a pack that cannot be dispatched. */}
              {series.xLabel.startsWith("State of charge") && (
                <ReferenceLine
                  x={SOC_CRITICAL}
                  stroke="var(--danger)"
                  strokeDasharray="4 4"
                  label={{ value: `${SOC_CRITICAL}% reserve`, fill: "var(--danger)", fontSize: 10, position: "top" }}
                />
              )}

              {series.trend && (
                <ReferenceLine
                  segment={[series.trend.from, series.trend.to]}
                  stroke="var(--info)"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  ifOverflow="extendDomain"
                />
              )}

              <Tooltip
                cursor={{ stroke: "var(--line-strong)", strokeDasharray: "3 3" }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as { label: string; meta: string; x: number; y: number };
                  return (
                    <div className="rounded-lg border border-line bg-surface p-2.5 text-[11px] shadow-[var(--shadow)]">
                      <p className="font-semibold text-ink">{p.label}</p>
                      <p className="num text-ink-2">
                        {series.xLabel}: {formatX(p.x)}
                      </p>
                      <p className="num text-ink-2">
                        {series.yLabel}: {p.y}
                      </p>
                      <p className="mt-1 text-ink-3">{p.meta}</p>
                      <p className="mt-1 text-accent">Click a point to select the pack</p>
                    </div>
                  );
                }}
              />

              <Scatter
                data={series.points}
                fill="var(--accent)"
                fillOpacity={0.75}
                stroke="var(--accent)"
                onClick={(point) => {
                  const id = (point as unknown as { id?: string })?.id;
                  if (id) select(id, "table");
                }}
                className="cursor-pointer"
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="border-t border-line bg-surface-2 px-4 py-3">
        <p className="text-[11px] font-medium text-ink">{series.title}</p>
        <p className="text-[11px] text-ink-2">{series.subtitle}</p>
        <p className="mt-1 text-[10px] leading-relaxed text-ink-3">{series.provenance}</p>
      </div>
    </Card>
  );
}
