"use client";

import { useMemo, useState } from "react";

import DraftDetailModal from "@/components/drafts/DraftDetailModal";
import DraftHeader from "@/components/drafts/DraftHeader";
import { Metric } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline } from "@/components/ui/Surface";

interface UsageSample {
  id: string;
  date: string;
  runtimeHours: number;
  fuelLitres: number;
  energyKwh: number;
  reason: string;
}

const AUGUST: UsageSample[] = [
  { id: "DG-2026-08-03", date: "03 Aug 2026", runtimeHours: 2.4, fuelLitres: 31, energyKwh: 196, reason: "Scheduled grid maintenance" },
  { id: "DG-2026-08-08", date: "08 Aug 2026", runtimeHours: 1.1, fuelLitres: 15, energyKwh: 88, reason: "Grid voltage below safe limit" },
  { id: "DG-2026-08-14", date: "14 Aug 2026", runtimeHours: 3.7, fuelLitres: 49, energyKwh: 301, reason: "Unplanned power interruption" },
  { id: "DG-2026-08-21", date: "21 Aug 2026", runtimeHours: 0.6, fuelLitres: 8, energyKwh: 44, reason: "Monthly load test" },
  { id: "DG-2026-08-29", date: "29 Aug 2026", runtimeHours: 1.9, fuelLitres: 25, energyKwh: 151, reason: "Peak-demand grid support" },
];

const JULY: UsageSample[] = [
  { id: "DG-2026-07-05", date: "05 Jul 2026", runtimeHours: 1.3, fuelLitres: 17, energyKwh: 102, reason: "Grid voltage below safe limit" },
  { id: "DG-2026-07-12", date: "12 Jul 2026", runtimeHours: 2.8, fuelLitres: 37, energyKwh: 226, reason: "Unplanned power interruption" },
  { id: "DG-2026-07-24", date: "24 Jul 2026", runtimeHours: 0.7, fuelLitres: 9, energyKwh: 51, reason: "Monthly load test" },
];

type Month = "August 2026" | "July 2026";

export default function DgDraft() {
  const [month, setMonth] = useState<Month>("August 2026");
  const [selected, setSelected] = useState<UsageSample | null>(null);
  const rows = month === "August 2026" ? AUGUST : JULY;
  const totals = useMemo(() => ({
    hours: rows.reduce((sum, row) => sum + row.runtimeHours, 0),
    fuel: rows.reduce((sum, row) => sum + row.fuelLitres, 0),
    energy: rows.reduce((sum, row) => sum + row.energyKwh, 0),
  }), [rows]);
  const dgCost = Math.round(totals.fuel * 96.4 + totals.hours * 420);
  const gridCost = Math.round(totals.energy * 9.1);

  return (
    <div className="space-y-4">
      <DraftHeader
        title="Diesel Generator"
        status="Draft view • Historical data integration planned"
        subtitle="Historical power resilience and cost-analysis concept for the Pune site"
      />

      <Card className="border-info/25 bg-info-soft/25">
        <CardHeader
          eyebrow="Module objective"
          title="Turn generator history into forward-looking operating decisions"
          description="Historical diesel-generator records will support power-cut prediction, site-demand forecasting, grid-versus-generator optimization and automated profit-and-loss reporting. No real-time generator feed is represented on this draft screen."
          actions={<Pill tone="info">Planned analytics</Pill>}
        />
      </Card>

      <Card>
        <CardHeader eyebrow="Generator status" title="Pune backup generator" actions={<Pill tone="ok" dot>Standby and available</Pill>} />
        <Hairline />
        <div className="grid grid-cols-2 gap-3 p-5 lg:grid-cols-5">
          <Metric label="Generator specification" value="125 kVA" />
          <Metric label="Current operating status" value="Standby" tone="ok" />
          <Metric label="Estimated fuel level" value={72} unit="%" tone="warn" />
          <Metric label="Most recent run" value="29 Aug, 18:42" />
          <Metric label="Runtime this month" value={totals.hours.toFixed(1)} unit=" hours" tone="info" />
        </div>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Historical records"
          title="Monthly generator usage"
          description="Select a month, then choose any run to inspect the representative record."
          actions={<Pill tone="neutral">{rows.length} recorded runs</Pill>}
        />
        <Hairline />
        <div className="flex gap-1.5 border-b border-line px-4 py-3" role="group" aria-label="Choose generator history month">
          {(["August 2026", "July 2026"] as Month[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMonth(option)}
              aria-pressed={month === option}
              className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${month === option ? "border-accent/35 bg-accent-soft text-accent" : "border-line bg-surface text-ink-2 hover:bg-surface-3"}`}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="bg-surface-2">
              <tr className="border-b border-line text-[11px] font-semibold text-ink-3">
                <th className="px-4 py-2">Run date</th>
                <th className="px-4 py-2 text-right">Runtime</th>
                <th className="px-4 py-2 text-right">Diesel fuel used</th>
                <th className="px-4 py-2 text-right">Electrical energy generated</th>
                <th className="px-4 py-2">Reason the generator started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(row);
                    }
                  }}
                  className="cursor-pointer border-b border-line transition last:border-0 hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
                >
                  <td className="num px-4 py-2.5 text-[12px] font-semibold text-ink">{row.date}</td>
                  <td className="num px-4 py-2.5 text-right text-[12px] text-ink">{row.runtimeHours.toFixed(1)} hours</td>
                  <td className="num px-4 py-2.5 text-right text-[12px] text-ink">{row.fuelLitres} litres</td>
                  <td className="num px-4 py-2.5 text-right text-[12px] text-ink">{row.energyKwh} kWh</td>
                  <td className="px-4 py-2.5 text-[12px] text-ink-2">{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="Profit and loss impact" title={`${month} energy-cost comparison`} description="Representative commercial assumptions; actual tariff and fuel invoices will replace these values during integration." />
        <Hairline />
        <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-3">
          <Metric label="Estimated generator cost this month" value={`₹${dgCost.toLocaleString("en-IN")}`} tone="warn" />
          <Metric label="Equivalent grid-electricity cost" value={`₹${gridCost.toLocaleString("en-IN")}`} tone="ok" />
          <Metric label="Additional cost from generator use" value={`₹${(dgCost - gridCost).toLocaleString("en-IN")}`} tone="warn" />
        </div>
      </Card>

      <DraftDetailModal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Generator run · ${selected.date}` : "Generator run"}
        subtitle="Representative historical record"
        fields={selected ? [
          { label: "Record identifier", value: selected.id },
          { label: "Runtime", value: `${selected.runtimeHours.toFixed(1)} hours` },
          { label: "Diesel fuel used", value: `${selected.fuelLitres} litres` },
          { label: "Electrical energy generated", value: `${selected.energyKwh} kWh` },
          { label: "Reason the generator started", value: selected.reason },
          { label: "Estimated fuel efficiency", value: `${(selected.energyKwh / selected.fuelLitres).toFixed(1)} kWh per litre` },
        ] : []}
      />
    </div>
  );
}
