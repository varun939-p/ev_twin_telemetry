"use client";

/**
 * Trucks Dashboard -- the "carrier" lens of the pivot.
 *
 * Shows exactly the carrier-relevant parameters: SOC (primary), residual
 * mileage, odometer and internal temperature.  SOH, charge cycles and power
 * generation are deliberately NOT rendered here -- they live on the Batteries
 * dashboard, per the product split.
 *
 * Filters (global): EV vs Non-EV, cascading State→City, and the map drill-down
 * focus.  The asset sidebar always reflects the full global filter; the map
 * overview ignores only the focus so a cluster can be (re)selected.
 */

import { useMemo, useState } from "react";

import DataIngestionPanel from "@/components/telemetry/DataIngestionPanel";
import GeoCascadeFilter from "@/components/telemetry/GeoCascadeFilter";
import InteractiveGeoMap from "@/components/telemetry/InteractiveGeoMap";
import LiveClock from "@/components/telemetry/LiveClock";
import ViewNav from "@/components/telemetry/ViewNav";
import { applyVehicleFilters, isEvVehicle, stateCounts, type EvFilter } from "@/lib/fleet";
import { useFilters } from "@/lib/FilterContext";
import { formatValue, numericValue, type TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

const CARD = "rounded-2xl border border-white/[0.06] bg-slate-900/40 backdrop-blur-md";
const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500";

function Tile({ label, value, unit, muted = false }: { label: string; value: string | null; unit?: string; muted?: boolean }) {
  return (
    <div className={`rounded-xl border border-white/[0.05] bg-black/25 px-4 py-3 ${muted ? "opacity-40" : ""}`}>
      <p className="text-[9px] font-medium uppercase tracking-[0.18em] text-slate-600">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-white">{value ?? "—"}</p>
      {unit && value !== null && <p className="text-[10px] text-slate-600">{unit}</p>}
    </div>
  );
}

export default function TrucksView({ data }: { data: TrustedTelemetryDocument }) {
  const filters = useFilters();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const vehicles = data.vehicles;

  /** Sidebar / detail scope: full global filter including focus. */
  const scoped = useMemo(() => applyVehicleFilters(vehicles, filters), [vehicles, filters]);
  /** Map overview scope: ev + geo, but NOT focus (so clusters stay clickable). */
  const mapScope = useMemo(
    () => applyVehicleFilters(vehicles, { ...filters, focus: null }),
    [vehicles, filters],
  );

  const counts = useMemo(() => stateCounts(vehicles), [vehicles]);

  /** Derived, not synced by an effect: when the filter drops the current pick
   *  (or nothing has been clicked yet) the first asset in scope is the
   *  selection.  Writing this back into state from an effect would cost an
   *  extra render on every filter change. */
  const selected = scoped.find((v) => v.vehicle_id === selectedId) ?? scoped[0] ?? null;

  const liveFields = useMemo(
    () => (selected ? Object.entries(selected.field_status).filter(([, s]) => s === "measured").map(([f]) => f) : []),
    [selected],
  );

  const medianSoc = useMemo(() => {
    const socs = scoped.map((v) => numericValue(v, "soc")).filter((s): s is number => s !== null).sort((a, b) => a - b);
    return socs.length ? socs[Math.floor(socs.length / 2)] : null;
  }, [scoped]);

  const evCount = scoped.filter((v) => isEvVehicle(v.vehicle_id)).length;

  const evOptions: { id: EvFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ev", label: "EV" },
    { id: "non-ev", label: "Non-EV" },
  ];

  return (
    <div className="min-h-screen bg-[#05070d] pb-12">
      <ViewNav active="trucks" />

      {/* header with live system clock */}
      <header className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-4 px-5 pt-6 lg:px-8">
        <div>
          <p className={EYEBROW}>Digital Twin · Carrier Layer</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Trucks Dashboard</h1>
          <p className="mt-1 text-[11px] text-slate-500">Trucks are carriers — battery packs are tracked on the Batteries dashboard.</p>
        </div>
        <LiveClock />
      </header>

      {/* persistent filters */}
      <div className="mx-auto mt-5 flex max-w-[1680px] flex-wrap items-center justify-between gap-3 px-5 lg:px-8">
        <GeoCascadeFilter counts={counts} />
        <div className="flex overflow-hidden rounded-full border border-white/[0.08]">
          {evOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => filters.setEv(opt.id)}
              className={`px-4 py-1.5 text-[11px] font-medium transition ${
                filters.ev === opt.id ? "bg-cyan-400/15 text-cyan-200" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* primary strip: completeness moved out; live-parameters indication in */}
      <div className="mx-auto mt-5 grid max-w-[1680px] grid-cols-2 gap-3 px-5 md:grid-cols-4 lg:px-8">
        <div className={CARD + " px-5 py-4"}>
          <p className={EYEBROW}>Assets in scope</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-white">{scoped.length}</p>
          <p className="text-[10px] text-slate-600">{evCount} EV · {scoped.length - evCount} non-EV</p>
        </div>
        <div className={CARD + " px-5 py-4"}>
          <p className={EYEBROW}>Live parameters</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-cyan-300">{data.pipeline_health.parameters_available}<span className="text-sm text-slate-600"> / {data.pipeline_health.parameters_total}</span></p>
          <p className="text-[10px] text-slate-600">active live metrics feeding this view</p>
        </div>
        <div className={CARD + " px-5 py-4"}>
          <p className={EYEBROW}>Median SOC</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-white">{medianSoc === null ? "—" : `${medianSoc}%`}</p>
          <p className="text-[10px] text-slate-600">across scoped carriers</p>
        </div>
        <div className={CARD + " px-5 py-4"}>
          <p className={EYEBROW}>Tracking</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-white">{filters.focus ? filters.focus.vehicleIds.length : scoped.length}</p>
          <p className="text-[10px] text-slate-600">{filters.focus ? `live scope — ${filters.focus.label}` : "assets on map"}</p>
        </div>
      </div>

      {/* asset list + detail */}
      <div className="mx-auto mt-5 grid max-w-[1680px] grid-cols-1 gap-4 px-5 lg:grid-cols-3 lg:px-8">
        <div className={CARD + " p-4"}>
          <div className="flex items-center justify-between">
            <h2 className={EYEBROW}>Carriers</h2>
            <span className="font-mono text-[10px] text-slate-600">{scoped.length}</span>
          </div>
          <ul className="mt-3 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
            {scoped.map((v) => {
              const soc = numericValue(v, "soc");
              const active = v.vehicle_id === selected?.vehicle_id;
              return (
                <li key={v.vehicle_id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(v.vehicle_id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                      active ? "border-cyan-400/30 bg-cyan-400/[0.07]" : "border-transparent hover:bg-white/[0.03]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-slate-200">{v.vehicle_id}</span>
                      <span className="font-mono text-[11px] text-cyan-300">{soc === null ? "—" : `${soc}%`}</span>
                    </div>
                    <p className="mt-0.5 text-[10px] text-slate-600">{isEvVehicle(v.vehicle_id) ? "EV carrier" : "Non-EV"} · {v.measured_count}/24 live</p>
                  </button>
                </li>
              );
            })}
            {scoped.length === 0 && <li className="rounded-lg border border-white/[0.06] px-3 py-6 text-center text-[11px] text-slate-600">No carriers match the current filters.</li>}
          </ul>
        </div>

        {/* detail: SOC primary; SOH / cycles / regen intentionally absent */}
        <div className={CARD + " p-5 lg:col-span-2"}>
          {selected ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className={EYEBROW}>Carrier</p>
                  <h2 className="mt-1 font-mono text-lg font-semibold text-white">{selected.vehicle_id}</h2>
                </div>
                <div className="text-right">
                  <p className="font-mono text-4xl font-semibold text-cyan-300">{formatValue(numericValue(selected, "soc"), "") ?? "—"}<span className="text-xl">%</span></p>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-slate-600">Battery SOC — primary</p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
                <Tile label="Residual Mileage" value={formatValue(numericValue(selected, "residual_mileage_km"), "")} unit="km" />
                <Tile label="Odometer" value={formatValue(numericValue(selected, "odometer_km"), "")} unit="km" />
                <Tile label="Internal Temp" value={formatValue(numericValue(selected, "battery_temp_c"), "")} unit="°C" />
              </div>

              <div className="mt-4">
                <p className={EYEBROW}>Live parameters indication ({liveFields.length} active)</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {liveFields.map((f) => (
                    <span key={f} className="rounded-full border border-emerald-400/15 bg-emerald-400/[0.05] px-2 py-0.5 font-mono text-[9px] text-emerald-200/90">
                      {f}
                    </span>
                  ))}
                  {liveFields.length === 0 && <span className="text-[10px] text-slate-600">No live parameters for this carrier.</span>}
                </div>
              </div>
            </>
          ) : (
            <p className="py-10 text-center text-sm text-slate-600">Select a carrier to inspect it.</p>
          )}
        </div>
      </div>

      {/* drill-down heatmap + live location */}
      <div className="mx-auto mt-5 max-w-[1680px] px-5 lg:px-8">
        <InteractiveGeoMap vehicles={mapScope} />
      </div>

      <div className="mx-auto mt-5 max-w-[1680px] px-5 lg:px-8">
        <DataIngestionPanel />
      </div>
    </div>
  );
}
