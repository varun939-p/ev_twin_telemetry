"use client";

import { useMemo } from "react";

import { CITIES_BY_STATE, INDIA_STATES } from "@/lib/fleet";
import { useFilters } from "@/lib/FilterContext";

/**
 * Persistent two-tier geography filter (Level 1: all 29 states, Level 2: city).
 * Shared by the Trucks and Batteries pages; state lives in the global
 * FilterContext so a selection follows the user across views.
 */
export default function GeoCascadeFilter({ counts }: { counts: Record<string, number> }) {
  const { geo, setGeo, clearAll, isFiltered } = useFilters();

  const cities = useMemo(() => (geo.state ? [...(CITIES_BY_STATE[geo.state] ?? [])] : []), [geo.state]);

  const select =
    "rounded-lg border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-200 outline-none focus:border-cyan-400/40 disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-slate-600">Region</span>

      {/* Level 1 -- state */}
      <select aria-label="Filter by state" className={select} value={geo.state ?? ""} onChange={(e) => setGeo({ state: e.target.value || null })}>
        <option value="">All states (29)</option>
        {INDIA_STATES.map((s) => (
          <option key={s} value={s}>
            {s}
            {counts[s] ? ` · ${counts[s]}` : ""}
          </option>
        ))}
      </select>

      {/* Level 2 -- city / sub-region */}
      <select
        aria-label="Filter by city"
        className={select}
        value={geo.city ?? ""}
        disabled={!geo.state}
        onChange={(e) => setGeo({ city: e.target.value || null })}
      >
        <option value="">{geo.state ? `All cities in ${geo.state}` : "Select a state first"}</option>
        {cities.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      {isFiltered && (
        <button type="button" onClick={clearAll} className="rounded-full border border-rose-400/25 bg-rose-400/10 px-2.5 py-1 text-[10px] font-medium text-rose-200 transition hover:bg-rose-400/20">
          Clear filters
        </button>
      )}
    </div>
  );
}
