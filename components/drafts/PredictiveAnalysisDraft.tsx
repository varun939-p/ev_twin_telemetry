"use client";

import { useMemo, useState } from "react";

import { DemandForecastChart } from "@/components/drafts/DraftCharts";
import DraftDetailModal from "@/components/drafts/DraftDetailModal";
import DraftHeader from "@/components/drafts/DraftHeader";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline } from "@/components/ui/Surface";

interface ModuleSample {
  id: string;
  title: string;
  description: string;
  status: "Designing model" | "Preparing data" | "Validating approach";
  input: string;
  output: string;
}

const MODULES: ModuleSample[] = [
  { id: "demand", title: "Demand Forecasting", description: "Predict battery-swap demand by site, day and operating shift.", status: "Designing model", input: "Swap history, arrivals and calendar effects", output: "Seven-day swaps and bay-capacity requirement" },
  { id: "maintenance", title: "Predictive Maintenance", description: "Identify batteries and charging equipment likely to require service.", status: "Preparing data", input: "Battery health, temperature and charge-cycle history", output: "Risk score, likely fault and recommended inspection" },
  { id: "route", title: "Route Pattern Analysis", description: "Learn recurring carrier routes and likely station-arrival windows.", status: "Validating approach", input: "GPS traces, speed and station visits", output: "Route clusters, arrival windows and range risk" },
  { id: "power", title: "Power Consumption Forecast", description: "Forecast grid demand and generator support before each peak.", status: "Designing model", input: "Charger load, swap demand, grid and generator history", output: "Hourly power requirement and least-cost supply plan" },
];

interface HealthSample {
  batteryId: string;
  currentHealth: number;
  projectedHealth: number;
  risk: "Low" | "Moderate" | "High";
  action: string;
}

const HEALTH: HealthSample[] = [
  { batteryId: "BAT-PUN-087", currentHealth: 91, projectedHealth: 89, risk: "Moderate", action: "Schedule a capacity test within 14 days" },
  { batteryId: "BAT-PUN-104", currentHealth: 96, projectedHealth: 95, risk: "Low", action: "Continue standard inspection cycle" },
  { batteryId: "BAT-PUN-111", currentHealth: 88, projectedHealth: 84, risk: "High", action: "Inspect cooling system before next deployment" },
  { batteryId: "BAT-PUN-118", currentHealth: 93, projectedHealth: 90, risk: "Moderate", action: "Review fast-charging exposure" },
  { batteryId: "BAT-PUN-126", currentHealth: 97, projectedHealth: 96, risk: "Low", action: "No intervention required" },
];

type HealthFilter = "All risk levels" | HealthSample["risk"];

function ModuleIcon({ id }: { id: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
      {id === "demand" && <><path d="M3 15.5h14M4.5 13l3-3 2.5 1.8 5-6" {...common} /><circle cx="15" cy="5.8" r="1.2" fill="currentColor" /></>}
      {id === "maintenance" && <><path d="M6 3.5v4l-2 2 2 2v5M14 3.5v4l2 2-2 2v5M8.5 9.5h3" {...common} /><circle cx="10" cy="9.5" r="3.2" {...common} /></>}
      {id === "route" && <><path d="M4 15c4-1 2-7 6-8s3 5 6 2" {...common} /><circle cx="4" cy="15" r="1.5" {...common} /><circle cx="16" cy="9" r="1.5" {...common} /></>}
      {id === "power" && <path d="M11.5 2.8L5 11h4l-.5 6.2L15 8.7h-4l.5-5.9z" {...common} />}
    </svg>
  );
}

function riskTone(risk: HealthSample["risk"]): "ok" | "warn" | "danger" {
  return risk === "Low" ? "ok" : risk === "Moderate" ? "warn" : "danger";
}

export default function PredictiveAnalysisDraft() {
  const [module, setModule] = useState<ModuleSample | null>(null);
  const [battery, setBattery] = useState<HealthSample | null>(null);
  const [filter, setFilter] = useState<HealthFilter>("All risk levels");
  const filtered = useMemo(() => filter === "All risk levels" ? HEALTH : HEALTH.filter((row) => row.risk === filter), [filter]);

  return (
    <div className="space-y-4">
      <DraftHeader
        title="Predictive Analysis"
        status="Draft view • Models under development"
        subtitle="Planned forecasting and decision-support modules using fleet and facility history"
      />

      <section aria-labelledby="analysis-modules">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-ink-3">Analysis roadmap</p>
            <h2 id="analysis-modules" className="display mt-1 text-[16px] font-bold text-ink">Planned prediction modules</h2>
          </div>
          <Pill tone="info">Four models planned</Pill>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {MODULES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setModule(item)}
              className="group cursor-pointer rounded-xl border border-line bg-surface p-5 text-left shadow-[var(--shadow)] transition hover:-translate-y-0.5 hover:border-accent/35 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-info-soft text-info"><ModuleIcon id={item.id} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold text-ink">{item.title}</span>
                    <Pill tone="warn">{item.status}</Pill>
                  </span>
                  <span className="mt-2 block text-[12px] leading-relaxed text-ink-2">{item.description}</span>
                  <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-accent">View model plan <span aria-hidden>→</span></span>
                </span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <Card>
        <CardHeader eyebrow="Demand forecasting" title="Seven-day battery-swap demand" description="Representative history is shown as a solid line; the planned forecast is shown as a dashed line." actions={<Pill tone="info">Sample projection</Pill>} />
        <Hairline />
        <div className="p-4">
          <DemandForecastChart actual={[42, 47, 45, 53]} forecast={[53, 58, 64, 61, 69, 73, 67]} />
          <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-ink-3">
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 bg-accent" />Observed sample</span>
            <span className="flex items-center gap-1.5"><span className="w-5 border-t-2 border-dashed border-info" />Predicted sample</span>
            <span className="ml-auto">Expected peak: 73 swaps on forecast day 6</span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="Battery health prediction" title="Projected battery health in 30 days" description="Choose a risk level or select any battery row to inspect the representative recommendation." actions={<Pill tone="neutral">{filtered.length} batteries shown</Pill>} />
        <Hairline />
        <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3" role="group" aria-label="Filter batteries by predicted risk">
          {(["All risk levels", "Low", "Moderate", "High"] as HealthFilter[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              aria-pressed={filter === option}
              className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${filter === option ? "border-accent/35 bg-accent-soft text-accent" : "border-line bg-surface text-ink-2 hover:bg-surface-3"}`}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="bg-surface-2">
              <tr className="border-b border-line text-[11px] font-semibold text-ink-3">
                <th className="px-4 py-2">Battery identifier</th>
                <th className="px-4 py-2 text-right">Current battery health</th>
                <th className="px-4 py-2 text-right">Predicted health in 30 days</th>
                <th className="px-4 py-2">Predicted risk level</th>
                <th className="px-4 py-2">Recommended action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.batteryId}
                  role="button"
                  tabIndex={0}
                  onClick={() => setBattery(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setBattery(row);
                    }
                  }}
                  className="cursor-pointer border-b border-line transition last:border-0 hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
                >
                  <td className="num px-4 py-2.5 text-[12px] font-semibold text-ink">{row.batteryId}</td>
                  <td className="num px-4 py-2.5 text-right text-[12px] text-ink">{row.currentHealth}%</td>
                  <td className="num px-4 py-2.5 text-right text-[12px] text-ink">{row.projectedHealth}%</td>
                  <td className="px-4 py-2.5"><Pill tone={riskTone(row.risk)} dot>{row.risk}</Pill></td>
                  <td className="px-4 py-2.5 text-[12px] text-ink-2">{row.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="Representative findings" title="Key predictive insights" />
        <Hairline />
        <ul className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-3">
          <li className="rounded-lg border border-warn/25 bg-warn-soft p-3"><p className="text-[12px] font-semibold text-warn">Demand pressure</p><p className="mt-1 text-[11px] leading-relaxed text-ink-2">Friday evening demand is projected to exceed current ready-pack capacity by 6 batteries.</p></li>
          <li className="rounded-lg border border-danger/25 bg-danger-soft p-3"><p className="text-[12px] font-semibold text-danger">Maintenance risk</p><p className="mt-1 text-[11px] leading-relaxed text-ink-2">BAT-PUN-111 shows the fastest projected health decline and should be inspected before deployment.</p></li>
          <li className="rounded-lg border border-info/25 bg-info-soft p-3"><p className="text-[12px] font-semibold text-info">Power opportunity</p><p className="mt-1 text-[11px] leading-relaxed text-ink-2">Moving 18% of charging load to 02:00–05:00 could avoid generator support during the evening peak.</p></li>
        </ul>
      </Card>

      <DraftDetailModal
        open={module !== null}
        onClose={() => setModule(null)}
        title={module?.title ?? "Prediction module"}
        subtitle="Planned model definition"
        fields={module ? [
          { label: "Development status", value: module.status },
          { label: "Planned input data", value: module.input },
          { label: "Planned decision output", value: module.output },
          { label: "Integration stage", value: "Historical data preparation" },
        ] : []}
      />

      <DraftDetailModal
        open={battery !== null}
        onClose={() => setBattery(null)}
        title={battery?.batteryId ?? "Battery health prediction"}
        subtitle="Representative 30-day health projection"
        fields={battery ? [
          { label: "Current battery health", value: `${battery.currentHealth}%` },
          { label: "Predicted health in 30 days", value: `${battery.projectedHealth}%` },
          { label: "Expected change", value: `${battery.projectedHealth - battery.currentHealth} percentage points` },
          { label: "Predicted risk level", value: battery.risk },
          { label: "Recommended action", value: battery.action },
          { label: "Model status", value: "Under development — sample result" },
        ] : []}
      />
    </div>
  );
}
