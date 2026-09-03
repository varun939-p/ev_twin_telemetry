"use client";

/**
 * Batteries Dashboard -- the tracked-asset lens of the pivot.
 *
 * Only the active EV frames (currently 3) become battery packs.  Each pack is
 * labelled `Battery <n>` from the `_EV<n>` suffix, and a mapping card shows the
 * truck chassis each pack is currently mounted in.  This view owns the
 * battery-health parameters the Trucks view deliberately omits: SOH, charge
 * cycles and power generation (regen), plus the predictive arrival block
 * (range / destination station / ETA).
 */

import { useMemo, useState } from "react";

import DataIngestionPanel from "@/components/telemetry/DataIngestionPanel";
import GeoCascadeFilter from "@/components/telemetry/GeoCascadeFilter";
import InteractiveGeoMap from "@/components/telemetry/InteractiveGeoMap";
import LiveClock from "@/components/telemetry/LiveClock";
import ViewNav from "@/components/telemetry/ViewNav";
import { applyVehicleFilters, deriveBatteries, formatEta, predictArrival, stateCounts, type BatteryAsset } from "@/lib/fleet";
import { useFilters } from "@/lib/FilterContext";
import { formatValue, numericValue, type TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

const CARD = "rounded-2xl border border-white/[0.06] bg-slate-900/40 backdrop-blur-md";
const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500";
const HAIRLINE = "h-px bg-white/[0.06]";

function Cell({ label, value, unit, tone = "text-white" }: { label: string; value: string | null; unit?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-black/25 px-3.5 py-3">
      <p className="text-[9px] font-medium uppercase tracking-[0.16em] text-slate-600">{label}</p>
      <p className={`mt-1 font-mono text-base font-semibold ${tone}`}>{value ?? "—"}</p>
      {unit && value !== null && <p className="text-[10px] text-slate-600">{unit}</p>}
    </div>
  );
}

export default function BatteriesView({ data }: { data: TrustedTelemetryDocument }) {
  const filters = useFilters();

  const batteries = useMemo(() => deriveBatteries(data.vehicles, 3), [data.vehicles]);
  const counts = useMemo(() => stateCounts(data.vehicles), [data.vehicles]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = batteries.find((b) => b.batteryId === selectedId) ?? batteries[0] ?? null;

  /** Geo filter applies to the pack list & map (EV frames only). */
  const evVehicles = useMemo(
    () => applyVehicleFilters(data.vehicles, { ...filters, ev: "ev", focus: null }),
    [data.vehicles, filters],
  );

  return (
    <div className="min-h-screen bg-[#05070d] pb-12">
      <ViewNav active="batteries" />

      <header className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-4 px-5 pt-6 lg:px-8">
        <div>
          <p className={EYEBROW}>Digital Twin · Asset Layer</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Batteries Dashboard</h1>
          <p className="mt-1 text-[11px] text-slate-500">Battery packs are the tracked asset — {batteries.length} active EV pack{batteries.length === 1 ? "" : "s"} live.</p>
        </div>
        <LiveClock />
      </header>

      <div className="mx-auto mt-5 max-w-[1680px] px-5 lg:px-8">
        <GeoCascadeFilter counts={counts} />
      </div>

      {/* battery -> truck mapping card */}
      <div className="mx-auto mt-5 max-w-[1680px] px-5 lg:px-8">
        <section className={CARD}>
          <header className="px-6 pb-4 pt-6">
            <p className={EYEBROW}>Pack ↔ Carrier Mapping</p>
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-white">Which pack is mounted in which truck</h2>
          </header>
          <div className={HAIRLINE} />
          <div className="grid grid-cols-1 gap-3 p-6 md:grid-cols-3">
            {batteries.map((b) => {
              const active = selected?.batteryId === b.batteryId;
              return (
                <button
                  key={b.batteryId}
                  type="button"
                  onClick={() => setSelectedId(b.batteryId)}
                  className={`rounded-xl border p-4 text-left transition ${
                    active ? "border-cyan-400/30 bg-cyan-400/[0.07]" : "border-white/[0.07] bg-black/20 hover:border-white/[0.16]"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-sm font-semibold text-cyan-200">{b.batteryId}</p>
                    <span className="rounded-full border border-white/[0.08] px-2 py-0.5 font-mono text-[9px] text-slate-500">slot {b.slot}</span>
                  </div>
                  <p className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-600">mounted in</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-200">{b.truckId}</p>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {/* per-battery detail */}
      <div className="mx-auto mt-5 max-w-[1680px] px-5 lg:px-8">
        {selected ? <BatteryDetail battery={selected} /> : <p className="py-10 text-center text-sm text-slate-600">No active battery packs in scope.</p>}
      </div>

      {/* pack positions on the live map */}
      <div className="mx-auto mt-5 max-w-[1680px] px-5 lg:px-8">
        <InteractiveGeoMap vehicles={evVehicles} />
      </div>

      <div className="mx-auto mt-5 max-w-[1680px] px-5 lg:px-8">
        <DataIngestionPanel />
      </div>
    </div>
  );
}

function BatteryDetail({ battery }: { battery: BatteryAsset }) {
  const v = battery.vehicle;
  const soc = numericValue(v, "soc");
  const arrival = useMemo(() => predictArrival(v), [v]);

  return (
    <section className={CARD}>
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 pb-4 pt-6">
        <div>
          <p className={EYEBROW}>Pack</p>
          <h2 className="mt-1 font-mono text-lg font-semibold text-white">{battery.batteryId}</h2>
          <p className="mt-0.5 text-[10px] text-slate-600">mounted in {battery.truckId}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-4xl font-semibold text-cyan-300">{formatValue(soc, "") ?? "—"}<span className="text-xl">%</span></p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-slate-600">State of Charge — primary</p>
        </div>
      </header>
      <div className={HAIRLINE} />

      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-3">
        {/* health: the parameters the Trucks view omits */}
        <div>
          <h3 className={EYEBROW}>Pack Health</h3>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <Cell label="State of Health" value={formatValue(numericValue(v, "soh"), "")} unit="%" tone="text-emerald-200" />
            <Cell label="Charge Cycles" value={formatValue(numericValue(v, "charge_cycles"), "")} unit="count" />
            <Cell label="Power Regeneration" value={formatValue(numericValue(v, "regen_kwh"), "")} unit="kWh" tone="text-amber-200" />
          </div>
        </div>

        {/* predictive arrival */}
        <div>
          <h3 className={EYEBROW}>Predictive Arrival</h3>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <Cell label="Est. Remaining Range" value={arrival.rangeKm === null ? null : String(arrival.rangeKm)} unit="km (SOC × kWh/km)" />
            <Cell label="Destination Station" value={arrival.station?.name ?? null} tone="text-cyan-200" />
            <Cell label="Estimated Arrival" value={formatEta(arrival.etaMinutes)} unit={arrival.distanceKm === null ? undefined : `${arrival.distanceKm} km away`} />
          </div>
        </div>

        {/* live indication */}
        <div>
          <h3 className={EYEBROW}>Live Parameters</h3>
          <p className="mt-3 font-mono text-2xl font-semibold text-cyan-300">{v.measured_count}<span className="text-sm text-slate-600"> / 24</span></p>
          <p className="text-[10px] text-slate-600">active live metrics on this pack</p>
          <p className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${arrival.feasible ? "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-200" : "border-rose-400/20 bg-rose-400/[0.06] text-rose-200"}`}>
            {arrival.feasible ? "Range covers the trip to the destination station." : "Range shortfall — plan a swap before dispatch."}
          </p>
        </div>
      </div>
    </section>
  );
}
