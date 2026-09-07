"use client";

import { useEffect, useMemo, useState } from "react";

import { Pill } from "@/components/ui/Pill";
import type { SwapStation } from "@/lib/fleet";

const STORAGE_KEY = "twin.central.selected-sites";

export default function SiteFilter({
  sites,
  selected,
  onChange,
}: {
  sites: readonly SwapStation[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const visibleSites = useMemo(
    () => sites.filter((site) => site.name.toLowerCase().includes(query.trim().toLowerCase())),
    [sites, query],
  );
  const allSelected = sites.length > 0 && selected.length === sites.length;

  return (
    <div className="w-full rounded-xl border border-line bg-surface p-2 shadow-[var(--shadow)] sm:w-auto sm:min-w-[420px]">
      <div className="flex items-center gap-2 px-2 pb-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent" aria-hidden>⌖</span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-3">Filter by site</p>
          <p className="truncate text-[11px] text-ink-2">{allSelected ? "All sites selected" : `${selected.length} of ${sites.length} sites selected`}</p>
        </div>
        <button type="button" onClick={() => onChange(allSelected ? [] : sites.map((site) => site.id))} className="cursor-pointer text-[11px] font-semibold text-accent hover:underline">
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
        <span className="text-ink-3" aria-hidden>⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a site" aria-label="Find a site" className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
        {query && <button type="button" onClick={() => setQuery("")} className="cursor-pointer text-ink-3 hover:text-ink" aria-label="Clear site search">×</button>}
      </div>
      <div className="scroll-thin mt-2 flex max-w-[min(78vw,620px)] gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Sites">
        {visibleSites.map((site) => {
          const active = selected.includes(site.id);
          return (
            <button key={site.id} type="button" aria-pressed={active} onClick={() => onChange(active ? selected.filter((id) => id !== site.id) : [...selected, site.id])} className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition ${active ? "border-accent bg-accent text-white shadow-sm" : "border-line bg-surface text-ink-2 hover:border-accent/40 hover:text-accent"}`}>
              <span>{site.name}</span>
              <span className={active ? "text-white/75" : "text-ink-3"}>{site.assetCount}</span>
            </button>
          );
        })}
        {visibleSites.length === 0 && <span className="px-2 py-1 text-xs text-ink-3">No matching sites</span>}
      </div>
      <div className="mt-2 flex items-center gap-2 px-2">
        <Pill tone={selected.length ? "info" : "warn"} dot>{selected.length ? `${selected.length} sites active` : "No site selected"}</Pill>
        <span className="text-[10px] text-ink-3">Updates the dashboard instantly</span>
      </div>
    </div>
  );
}

export function usePersistedSiteSelection(sites: readonly SwapStation[]) {
  const defaultIds = useMemo(() => {
    const pune = sites.find((site) => site.name.toLowerCase().includes("pune"));
    return pune ? [pune.id] : sites.length ? [sites[0].id] : [];
  }, [sites]);
  const [selected, setSelected] = useState<string[]>(defaultIds);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
        if (Array.isArray(saved)) setSelected(saved.filter((value): value is string => typeof value === "string" && sites.some((site) => site.id === value)));
      } catch { /* localStorage can be blocked; the live default remains usable. */ }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(id);
  }, [sites]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch { /* best effort persistence */ }
  }, [selected, hydrated]);

  return [selected, setSelected] as const;
}
