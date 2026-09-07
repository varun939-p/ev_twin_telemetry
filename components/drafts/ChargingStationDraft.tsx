"use client";

import { useMemo, useState } from "react";

import { UtilizationChart } from "@/components/drafts/DraftCharts";
import DraftDetailModal from "@/components/drafts/DraftDetailModal";
import DraftHeader from "@/components/drafts/DraftHeader";
import { KpiCard, Metric } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline } from "@/components/ui/Surface";

interface ChargerSample {
  id: string;
  type: "DC Fast" | "AC Slow";
  status: "Charging" | "Available" | "Under maintenance";
  batteryId: string | null;
  chargePct: number | null;
  powerKw: number;
  etaMinutes: number | null;
}

const CHARGERS: ChargerSample[] = [
  { id: "CHG-PUN-01", type: "DC Fast", status: "Charging", batteryId: "BAT-PUN-118", chargePct: 68, powerKw: 92, etaMinutes: 24 },
  { id: "CHG-PUN-02", type: "DC Fast", status: "Charging", batteryId: "BAT-PUN-121", chargePct: 41, powerKw: 108, etaMinutes: 49 },
  { id: "CHG-PUN-03", type: "DC Fast", status: "Available", batteryId: null, chargePct: null, powerKw: 0, etaMinutes: null },
  { id: "CHG-PUN-04", type: "DC Fast", status: "Charging", batteryId: "BAT-PUN-126", chargePct: 76, powerKw: 74, etaMinutes: 18 },
  { id: "CHG-PUN-05", type: "AC Slow", status: "Available", batteryId: null, chargePct: null, powerKw: 0, etaMinutes: null },
  { id: "CHG-PUN-06", type: "AC Slow", status: "Available", batteryId: null, chargePct: null, powerKw: 0, etaMinutes: null },
  { id: "CHG-PUN-07", type: "AC Slow", status: "Under maintenance", batteryId: null, chargePct: null, powerKw: 0, etaMinutes: null },
  { id: "CHG-PUN-08", type: "AC Slow", status: "Available", batteryId: null, chargePct: null, powerKw: 0, etaMinutes: null },
];

const UTILIZATION = [18, 12, 9, 7, 8, 14, 28, 46, 62, 74, 81, 77, 69, 72, 84, 91, 86, 79, 71, 63, 52, 44, 33, 24] as const;
type Filter = "All chargers" | ChargerSample["status"];

function statusTone(status: ChargerSample["status"]): "ok" | "info" | "warn" {
  if (status === "Charging") return "info";
  if (status === "Available") return "ok";
  return "warn";
}

export default function ChargingStationDraft() {
  const [selected, setSelected] = useState<ChargerSample | null>(null);
  const [filter, setFilter] = useState<Filter>("All chargers");
  const filtered = useMemo(
    () => filter === "All chargers" ? CHARGERS : CHARGERS.filter((charger) => charger.status === filter),
    [filter],
  );
  const currentDraw = CHARGERS.reduce((sum, charger) => sum + charger.powerKw, 0);

  return (
    <div className="space-y-4">
      <DraftHeader
        title="Charging Station"
        status="Draft view • Live integration pending"
        subtitle="Pune charging operations concept with representative sample data"
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total Charging Points" value={CHARGERS.length} tone="neutral" />
        <KpiCard label="Charging Batteries Now" value={CHARGERS.filter((charger) => charger.status === "Charging").length} tone="info" />
        <KpiCard label="Charging Points Available" value={CHARGERS.filter((charger) => charger.status === "Available").length} tone="ok" />
        <KpiCard label="Charging Points Under Maintenance" value={CHARGERS.filter((charger) => charger.status === "Under maintenance").length} tone="warn" />
      </div>

      <Card>
        <CardHeader eyebrow="Power consumption" title="Current station power supply" description="Representative values for the planned site-controller integration." />
        <Hairline />
        <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-3">
          <Metric label="Current charging power draw" value={currentDraw} unit=" kW" tone="info" />
          <Metric label="Power supplied by the grid" value={250} unit=" kW" tone="ok" />
          <Metric label="Power supplied by the diesel generator" value={Math.max(0, currentDraw - 250)} unit=" kW" tone={currentDraw > 250 ? "warn" : "neutral"} />
        </div>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Charging point register"
          title="Charging point details"
          description="Select a status or any table row to inspect the sample record."
          actions={<Pill tone="neutral">{filtered.length} shown</Pill>}
        />
        <Hairline />
        <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3" role="group" aria-label="Filter charging points by status">
          {(["All chargers", "Charging", "Available", "Under maintenance"] as Filter[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              aria-pressed={filter === option}
              className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${
                filter === option ? "border-accent/35 bg-accent-soft text-accent" : "border-line bg-surface text-ink-2 hover:bg-surface-3 hover:text-ink"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-left">
            <thead className="bg-surface-2">
              <tr className="border-b border-line text-[11px] font-semibold text-ink-3">
                <th className="px-4 py-2">Charging point identifier</th>
                <th className="px-4 py-2">Charger type</th>
                <th className="px-4 py-2">Operating status</th>
                <th className="px-4 py-2">Connected battery</th>
                <th className="px-4 py-2 text-right">Battery charge level</th>
                <th className="px-4 py-2 text-right">Charging power</th>
                <th className="px-4 py-2 text-right">Estimated time remaining</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((charger) => (
                <tr
                  key={charger.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(charger)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(charger);
                    }
                  }}
                  className="cursor-pointer border-b border-line transition last:border-0 hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
                >
                  <td className="num px-4 py-2.5 text-[12px] font-semibold text-ink">{charger.id}</td>
                  <td className="px-4 py-2.5 text-[12px] text-ink-2">{charger.type}</td>
                  <td className="px-4 py-2.5"><Pill tone={statusTone(charger.status)} dot>{charger.status}</Pill></td>
                  <td className="num px-4 py-2.5 text-[12px] text-ink-2">{charger.batteryId ?? "No battery connected"}</td>
                  <td className="num px-4 py-2.5 text-right text-[12px] text-ink">{charger.chargePct === null ? "—" : `${charger.chargePct}%`}</td>
                  <td className="num px-4 py-2.5 text-right text-[12px] text-ink">{charger.powerKw} kW</td>
                  <td className="num px-4 py-2.5 text-right text-[12px] text-ink-2">{charger.etaMinutes === null ? "Not applicable" : `${charger.etaMinutes} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="24-hour pattern" title="Charging point utilization" description="Sample percentage of charging points in use during each hour." actions={<Pill tone="info">Sample forecast</Pill>} />
        <Hairline />
        <div className="p-4"><UtilizationChart values={UTILIZATION} /></div>
      </Card>

      <DraftDetailModal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.id ?? "Charging point"}
        subtitle="Representative charging point record"
        fields={selected ? [
          { label: "Charger type", value: selected.type },
          { label: "Operating status", value: selected.status },
          { label: "Connected battery", value: selected.batteryId ?? "No battery connected" },
          { label: "Battery charge level", value: selected.chargePct === null ? "Not available" : `${selected.chargePct}%` },
          { label: "Charging power", value: `${selected.powerKw} kW` },
          { label: "Estimated time remaining", value: selected.etaMinutes === null ? "Not applicable" : `${selected.etaMinutes} minutes` },
        ] : []}
      />
    </div>
  );
}
