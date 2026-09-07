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
  const visibleSites = useMemo(() => sites.filter((site) => site.name.toLowerCase().includes(query.trim().toLowerCase())), [sites, query]);
  const allSelected = sites.length > 0 && selected.length === sites.length;
  const selectedNames = sites.filter((site) => selected.includes(site.id)).map((site) => site.name);

  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);

  return (
    <details className="group relative w-full sm:w-[280px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-[var(--shadow)] transition hover:border-accent/40 [&::-webkit-details-marker]:hidden">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent" aria-hidden>⌖</span>
        <span className="min-w-0 flex-1 text-left">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3">Site</span>
          <span className="block truncate text-xs font-semibold text-ink">{selectedNames.length === 1 ? selectedNames[0] : allSelected ? "All sites" : `${selected.length} sites selected`}</span>
        </span>
        <span className="text-ink-3 transition group-open:rotate-180" aria-hidden>⌄</span>
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-full min-w-[280px] rounded-xl border border-line bg-surface p-2 shadow-[0_16px_40px_rgba(16,24,40,.14)]">
        <div className="flex items-center justify-between px-2 pb-2">
          <p className="text-[11px] font-semibold text-ink">Choose sites</p>
          <button type="button" onClick={() => onChange(allSelected ? [] : sites.map((site) => site.id))} className="cursor-pointer text-[11px] font-semibold text-accent hover:underline">{allSelected ? "Clear" : "All"}</button>
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2">
          <span className="text-ink-3" aria-hidden>⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sites" aria-label="Search sites" className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3" />
        </label>
        <div className="scroll-thin mt-2 max-h-52 space-y-1 overflow-y-auto">
          {visibleSites.map((site) => {
            const active = selected.includes(site.id);
            return <button key={site.id} type="button" aria-pressed={active} onClick={() => toggle(site.id)} className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-2"}`}>
              <span className={`grid h-4 w-4 place-items-center rounded border text-[10px] ${active ? "border-accent bg-accent text-white" : "border-line-strong"}`}>{active ? "✓" : ""}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{site.name}</span>
              <span className="num text-[10px] text-ink-3">{site.assetCount}</span>
            </button>;
          })}
          {!visibleSites.length && <p className="px-2 py-3 text-xs text-ink-3">No sites found</p>}
        </div>
        <div className="mt-2 border-t border-line px-2 pt-2"><Pill tone={selected.length ? "info" : "warn"} dot>{selected.length ? `${selected.length} active` : "Select a site"}</Pill></div>
      </div>
    </details>
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
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
        if (Array.isArray(saved)) setSelected(saved.filter((value): value is string => typeof value === "string" && sites.some((site) => site.id === value)));
      } catch { /* best effort */ }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sites]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch { /* best effort */ }
  }, [selected, hydrated]);

  return [selected, setSelected] as const;
}
