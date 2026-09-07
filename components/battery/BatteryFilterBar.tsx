"use client";

import { FilterChip, GhostButton, SegmentedControl, Select } from "@/components/ui/Field";
import { SOC_BRACKETS, type GeoIndex, type SocBracket, type SwapStation } from "@/lib/fleet";
import { useIsFiltered, useTwin } from "@/lib/store";

/**
 * Battery Tracking filter bar.
 *
 * Three narrowing axes required by the spec — swap station, geography and SOC
 * bracket — written into the SAME store the truck page uses.  A region chosen
 * here therefore survives navigation to Truck Telemetry, which is the whole
 * point of hoisting filters out of the pages.
 *
 * The station selector is derived from `SWAP_STATIONS` and matched by nearest
 * hub to each pack's measured fix (`nearestStation`), so "batteries at this
 * site" is a real geographic assignment rather than a hard-coded list.
 */
export default function BatteryFilterBar({
  sites,
  stationCounts,
  geoIndex,
  scopedCount,
  totalCount,
}: {
  /** Sites derived from the live payload, in fleet-presence order. */
  sites: readonly SwapStation[];
  stationCounts: Record<string, number>;
  /** Regions present in the DATA, with live counts — never a hardcoded list. */
  geoIndex: GeoIndex;
  scopedCount: number;
  totalCount: number;
}) {
  const geo = useTwin((s) => s.geo);
  const soc = useTwin((s) => s.soc);
  const stationId = useTwin((s) => s.stationId);
  const focus = useTwin((s) => s.focus);
  const setGeo = useTwin((s) => s.setGeo);
  const setSoc = useTwin((s) => s.setSoc);
  const setStation = useTwin((s) => s.setStation);
  const setFocus = useTwin((s) => s.setFocus);
  const clearFilters = useTwin((s) => s.clearFilters);
  const isFiltered = useIsFiltered();

  return (
    <div className="rounded-xl border border-line bg-surface p-3 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Swap station"
          value={stationId}
          placeholder="All stations"
          onChange={setStation}
          options={sites.map((s) => ({ value: s.id, label: s.name, badge: stationCounts[s.id] ?? s.assetCount }))}
          className="w-[190px]"
        />

        <Select
          label="Region"
          value={geo.region}
          placeholder="All regions"
          onChange={(region) => setGeo({ region })}
          options={geoIndex.regions.map((r) => ({ value: r.value, label: r.value, badge: r.count }))}
          className="w-[158px]"
        />

        <SegmentedControl<SocBracket>
          label="State of charge"
          value={soc}
          onChange={setSoc}
          options={SOC_BRACKETS.map((b) => ({ value: b.id, label: b.label }))}
        />

        <div className="ml-auto flex items-end gap-2">
          <p className="text-[12px] text-ink-2">
            <span className="num font-semibold text-ink">{scopedCount}</span>
            <span className="text-ink-3"> / {totalCount} packs in scope</span>
          </p>
          {isFiltered && (
            <GhostButton tone="danger" onClick={clearFilters} title="Reset every filter">
              Clear all
            </GhostButton>
          )}
        </div>
      </div>

      {(focus || soc !== "all") && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
          {focus && (
            <FilterChip onClear={() => setFocus(null)}>
              Map drill-down · {focus.label} · <span className="num">{focus.vehicleIds.length}</span> assets
            </FilterChip>
          )}
          {soc !== "all" && (
            <FilterChip tone="info" onClear={() => setSoc("all")}>
              {SOC_BRACKETS.find((b) => b.id === soc)?.label} · batteries without a reported charge level are excluded
            </FilterChip>
          )}
        </div>
      )}
    </div>
  );
}
