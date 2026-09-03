"use client";

import { useMemo } from "react";

import { CITIES_BY_STATE, INDIA_STATES } from "@/lib/fleet";
import { useFilters } from "@/lib/FilterContext";

/**
 * Consolidated global filter bar -- one component, identical on every page:
 *
 *   [ All | EV · n | Non-EV · n ]   Region: [state ▾] [city ▾]   (drill-down chip ✕)
 *
 * All state lives in the FilterContext, so a selection made here narrows the
 * asset list, the map and every other consumer at once -- and survives
 * client-side navigation.  Interactivity is explicit: native selects get
 * `appearance-none` + a custom chevron and `cursor-pointer`, and the active
 * map drill-down renders as a removable chip so the narrowed list never looks
 * like a filter that "did nothing".
 */
export default function GeoCascadeFilter({
  counts,
  evCounts,
}: {
  /** Per-state asset counts, for Level-1 badges. */
  counts: Record<string, number>;
  /** Fleet-wide EV split, for the segment badges. */
  evCounts?: { ev: number; nonEv: number };
}) {
  const { geo, setGeo, ev, setEv, focus, setFocus, clearAll, isFiltered } = useFilters();

  const cities = useMemo(() => (geo.state ? [...(CITIES_BY_STATE[geo.state] ?? [])] : []), [geo.state]);

  const evOptions: { id: "all" | "ev" | "non-ev"; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ev", label: evCounts ? `EV · ${evCounts.ev}` : "EV" },
    { id: "non-ev", label: evCounts ? `Non-EV · ${evCounts.nonEv}` : "Non-EV" },
  ];

  const selectWrap = "relative";
  const select =
    "cursor-pointer appearance-none rounded-lg border border-white/[0.08] bg-black/30 py-1.5 pl-2.5 pr-7 text-[11px] text-slate-200 outline-none transition hover:border-white/[0.2] focus:border-cyan-400/40 disabled:cursor-not-allowed disabled:opacity-40";
  const chevron = (
    <svg viewBox="0 0 12 12" aria-hidden className="pointer-events-none absolute right-2 top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-slate-500">
      <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* EV segment -- battery packs vs. plain carriers */}
      <div className="flex overflow-hidden rounded-full border border-white/[0.08]" role="group" aria-label="Asset type filter">
        {evOptions.map((opt) => (
          <button
            key={opt.id}
            type="button"
            aria-pressed={ev === opt.id}
            onClick={() => setEv(opt.id)}
            className={`cursor-pointer px-3.5 py-1.5 text-[11px] font-medium transition ${
              ev === opt.id ? "bg-cyan-400/15 text-cyan-200" : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-300"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <span className="ml-1 text-[9px] font-medium uppercase tracking-[0.18em] text-slate-600">Region</span>

      {/* Level 1 -- state */}
      <span className={selectWrap}>
        <select aria-label="Filter by state" className={select} value={geo.state ?? ""} onChange={(e) => setGeo({ state: e.target.value || null })}>
          <option value="">All states ({INDIA_STATES.length})</option>
          {INDIA_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
              {counts[s] ? ` · ${counts[s]}` : ""}
            </option>
          ))}
        </select>
        {chevron}
      </span>

      {/* Level 2 -- city / sub-region (cascade: needs a state first) */}
      <span className={selectWrap}>
        <select
          aria-label="Filter by city"
          className={select}
          value={geo.city ?? ""}
          disabled={!geo.state}
          onChange={(e) => setGeo({ city: e.target.value || null })}
        >
          <option value="">{geo.state ? `All cities in ${geo.state}` : "City — pick a state first"}</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {chevron}
      </span>

      {/* Active map drill-down: visible, labelled, one click to clear */}
      {focus && (
        <button
          type="button"
          onClick={() => setFocus(null)}
          title="Clear the map drill-down and show the full list"
          className="flex cursor-pointer items-center gap-1.5 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-[11px] font-medium text-cyan-200 transition hover:bg-cyan-400/20"
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-cyan-400" />
          </span>
          {focus.label} · {focus.vehicleIds.length} assets
          <span aria-hidden className="text-cyan-300/70">
            ✕
          </span>
        </button>
      )}

      {isFiltered && !focus && (
        <button
          type="button"
          onClick={clearAll}
          className="cursor-pointer rounded-full border border-rose-400/25 bg-rose-400/10 px-2.5 py-1 text-[10px] font-medium text-rose-200 transition hover:bg-rose-400/20"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
