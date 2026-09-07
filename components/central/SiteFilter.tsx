"use client";

import { memo, useMemo } from "react";

import type { SwapStation } from "@/lib/fleet";

interface SiteFilterProps {
  sites: readonly SwapStation[];
  selectedIds: readonly string[];
  onChange: (siteIds: string[]) => void;
}

/** Executive single-site switcher. One selection drives the entire page. */
function SiteFilter({ sites, selectedIds, onChange }: SiteFilterProps) {
  const selectedId = selectedIds[0] ?? sites[0]?.id ?? "";
  const activeSite = useMemo(
    () => sites.find((site) => site.id === selectedId) ?? sites[0] ?? null,
    [selectedId, sites],
  );

  return (
    <section
      aria-label="Central Dashboard operating site"
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-[var(--shadow)] sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">Operating site</p>
        <div className="mt-1 flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-ok ring-4 ring-ok/10" aria-hidden />
          <p className="truncate text-[13px] font-semibold text-ink">{activeSite?.name ?? "No site available"}</p>
          {activeSite && (
            <span className="num shrink-0 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-ink-2">
              {activeSite.assetCount} assets
            </span>
          )}
        </div>
      </div>

      <label className="relative block w-full sm:w-[300px]">
        <span className="sr-only">Choose operating site</span>
        <select
          value={selectedId}
          onChange={(event) => onChange([event.target.value])}
          disabled={sites.length === 0}
          className="h-10 w-full cursor-pointer appearance-none rounded-lg border border-line-strong bg-surface-2 py-0 pl-3 pr-10 text-[13px] font-semibold text-ink shadow-sm outline-none transition hover:border-accent/40 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
        <svg
          viewBox="0 0 20 20"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
          aria-hidden
        >
          <path d="m6 8 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </label>
    </section>
  );
}

export default memo(SiteFilter);
