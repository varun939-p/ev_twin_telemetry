"use client";

import { useMemo, useState } from "react";

import SiteCanvas from "@/components/central/SiteCanvas";
import DraftDetailModal from "@/components/drafts/DraftDetailModal";
import DraftHeader from "@/components/drafts/DraftHeader";
import { KpiCard, Metric } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline } from "@/components/ui/Surface";
import type { SwapStation } from "@/lib/fleet";
import type { InboundSeed, PackSeed } from "@/lib/site-model";

interface SlotSample {
  bay: number;
  batteryId: string | null;
  chargePct: number | null;
  status: "Charging" | "Ready for swap" | "Reserved" | "Vacant";
  minutesToFull: number | null;
}

const STATION: SwapStation = {
  id: "pune-draft",
  name: "Pune Swap Station",
  state: "Maharashtra",
  lat: 18.5204,
  lon: 73.8567,
  bays: 8,
  assetCount: 18,
};

const SLOTS: SlotSample[] = [
  { bay: 1, batteryId: "BAT-PUN-104", chargePct: 92, status: "Ready for swap", minutesToFull: 0 },
  { bay: 2, batteryId: "BAT-PUN-118", chargePct: 68, status: "Charging", minutesToFull: 24 },
  { bay: 3, batteryId: "BAT-PUN-121", chargePct: 41, status: "Charging", minutesToFull: 49 },
  { bay: 4, batteryId: "BAT-PUN-097", chargePct: 100, status: "Reserved", minutesToFull: 0 },
  { bay: 5, batteryId: "BAT-PUN-126", chargePct: 76, status: "Charging", minutesToFull: 18 },
  { bay: 6, batteryId: null, chargePct: null, status: "Vacant", minutesToFull: null },
  { bay: 7, batteryId: "BAT-PUN-111", chargePct: 88, status: "Ready for swap", minutesToFull: 0 },
  { bay: 8, batteryId: "BAT-PUN-132", chargePct: 53, status: "Charging", minutesToFull: 35 },
];

const PACKS: PackSeed[] = SLOTS.filter((slot): slot is SlotSample & { batteryId: string; chargePct: number } =>
  slot.batteryId !== null && slot.chargePct !== null,
).map((slot) => ({ vehicleId: `SAMPLE-${slot.batteryId}`, batteryLabel: slot.batteryId, soc: slot.chargePct }));

const INBOUND: InboundSeed[] = [
  { vehicleId: "SAMPLE-MH12-TV-2041", carrierLabel: "MH12 TV 2041", distanceKm: 7, etaMinutes: 11, soc: 17 },
  { vehicleId: "SAMPLE-MH14-KQ-9018", carrierLabel: "MH14 KQ 9018", distanceKm: 14, etaMinutes: 22, soc: 24 },
];

function slotTone(status: SlotSample["status"]): "ok" | "info" | "warn" | "neutral" {
  if (status === "Ready for swap") return "ok";
  if (status === "Charging") return "info";
  if (status === "Reserved") return "warn";
  return "neutral";
}

export default function SwapStationDraft() {
  const [selected, setSelected] = useState<SlotSample | null>(null);
  const chargingCount = useMemo(() => SLOTS.filter((slot) => slot.status === "Charging").length, []);

  return (
    <div className="space-y-4">
      <DraftHeader
        title="Swap Station"
        status="Draft view • Live integration pending"
        subtitle="Pune station operating concept with representative sample data"
      />

      <Card>
        <CardHeader
          eyebrow="Site overview"
          title="Pune Swap Station"
          description="Wakad Logistics Park, Pune, Maharashtra"
          actions={<Pill tone="ok" dot pulse>Operational concept</Pill>}
        />
        <Hairline />
        <div className="grid grid-cols-2 gap-3 p-5 lg:grid-cols-4">
          <Metric label="Operating status" value="Open" tone="ok" />
          <Metric label="Battery bay capacity" value={8} unit=" bays" />
          <Metric label="Bays currently charging" value={chargingCount} tone="info" />
          <Metric label="Bays ready for a swap" value={2} tone="ok" />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          eyebrow="Facility visualization"
          title="Pune station operating model"
          description="Sample pack occupancy and truck arrival states drive this lightweight real-time facility scene."
          actions={<Pill tone="info">Representative data</Pill>}
        />
        <Hairline />
        <div className="p-2 sm:p-3">
          <SiteCanvas packs={PACKS} inbound={INBOUND} station={STATION} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KpiCard label="Battery Swaps Completed Today" value={46} tone="ok" hint="Sample total through 16:00" />
        <KpiCard label="Average Battery Swap Time" value="6 min 42 sec" tone="info" hint="Sample average across today's completed swaps" />
      </div>

      <Card>
        <CardHeader
          eyebrow="Eight-bay layout"
          title="Battery bay status"
          description="Select any bay to inspect its representative operating details."
          actions={<Pill tone="neutral">{SLOTS.filter((slot) => slot.status !== "Vacant").length} occupied</Pill>}
        />
        <Hairline />
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {SLOTS.map((slot) => (
            <button
              key={slot.bay}
              type="button"
              onClick={() => setSelected(slot)}
              className="group cursor-pointer rounded-xl border border-line bg-surface-2 p-3 text-left transition hover:-translate-y-0.5 hover:border-accent/35 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-ink-3">Battery bay {slot.bay}</span>
                <Pill tone={slotTone(slot.status)} dot={slot.status !== "Vacant"}>{slot.status}</Pill>
              </div>
              <p className="num mt-3 text-[14px] font-semibold text-ink">{slot.batteryId ?? "No battery assigned"}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <span
                  className={`block h-full rounded-full ${slot.status === "Ready for swap" ? "bg-ok" : slot.status === "Reserved" ? "bg-warn" : "bg-info"}`}
                  style={{ width: `${slot.chargePct ?? 0}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-ink-3">
                <span>{slot.chargePct === null ? "Charge unavailable" : `${slot.chargePct}% charged`}</span>
                <span>{slot.minutesToFull === null ? "Awaiting battery" : slot.minutesToFull === 0 ? "Ready now" : `${slot.minutesToFull} min to full`}</span>
              </div>
            </button>
          ))}
        </div>
      </Card>

      <DraftDetailModal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Battery bay ${selected.bay}` : "Battery bay"}
        subtitle="Representative sample record"
        fields={selected ? [
          { label: "Battery identifier", value: selected.batteryId ?? "No battery assigned" },
          { label: "Current charge level", value: selected.chargePct === null ? "Not available" : `${selected.chargePct}%` },
          { label: "Charging status", value: selected.status },
          { label: "Estimated time until full", value: selected.minutesToFull === null ? "Not applicable" : selected.minutesToFull === 0 ? "Ready now" : `${selected.minutesToFull} minutes` },
        ] : []}
      />
    </div>
  );
}
