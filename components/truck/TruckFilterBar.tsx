"use client";

import { useMemo } from "react";

import { FilterChip, GhostButton, SegmentedControl, Select } from "@/components/ui/Field";
import type { EvFilter, GeoIndex } from "@/lib/fleet";
import { useIsFiltered, useTwin } from "@/lib/store";

/**
 * Global filter bar — mounted directly ABOVE the carrier table, never floating
 * over the map.  The map is a view of the filtered scope; the controls that
 * produce that scope sit with the data they narrow.
 *
 * Cascade: Region -> State -> City.  Invalidation is owned by the store
 * (`setGeo`), not by these three dropdowns, so a state that falls outside a
 * newly chosen region is dropped exactly once, in one place.
 *
 * Every control writes to the same store the map writes to, which is why a
 * cluster click ("Pune 29") lights up the State and City selects here — the
 * map is not a special case, it is just another writer.
 */
export default function TruckFilterBar({
  geoIndex,
  evCounts,
  scopedCount,
  totalCount,
}: {
  /** Regions/states/cities present in the DATA, with live counts. */
  geoIndex: GeoIndex;
  evCounts: { ev: number; nonEv: number };
  scopedCount: number;
  totalCount: number;
}) {
  const ev = useTwin((s) => s.ev);
  const geo = useTwin((s) => s.geo);
  const focus = useTwin((s) => s.focus);
  const setEv = useTwin((s) => s.setEv);
  const setGeo = useTwin((s) => s.setGeo);
  const setFocus = useTwin((s) => s.setFocus);
  const clearFilters = useTwin((s) => s.clearFilters);
  const isFiltered = useIsFiltered();

  // Options come from the dataset, never from a hardcoded list: pick a region
  // and the State select narrows to the states in that region that actually
  // have carriers.
  const states = useMemo(
    () => (geo.region ? (geoIndex.statesByRegion[geo.region] ?? []) : geoIndex.states),
    [geo.region, geoIndex],
  );
  const cities = useMemo(
    () => (geo.state ? (geoIndex.citiesByState[geo.state] ?? []) : []),
    [geo.state, geoIndex],
  );

  return (
    <div className="rounded-xl border border-line bg-surface p-3 shadow-[var(--shadow)]">
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl<EvFilter>
          label="Powertrain"
          value={ev}
          onChange={setEv}
          options={[
            { value: "all", label: "All", count: evCounts.ev + evCounts.nonEv },
            { value: "ev", label: "EV", count: evCounts.ev },
            { value: "non-ev", label: "Non-EV", count: evCounts.nonEv },
          ]}
        />

        <Select
          label="Region"
          value={geo.region}
          placeholder="All regions"
          onChange={(region) => setGeo({ region })}
          options={geoIndex.regions.map((r) => ({ value: r.value, label: r.value, badge: r.count }))}
          className="w-[150px]"
        />

        <Select
          label="State"
          value={geo.state}
          placeholder={geo.region ? `All states in ${geo.region}` : `All states · ${geoIndex.states.length}`}
          onChange={(state) => setGeo({ state })}
          options={states.map((s) => ({ value: s.value, label: s.value, badge: s.count }))}
          className="w-[188px]"
        />

        <Select
          label="City"
          value={geo.city}
          placeholder={geo.state ? `All cities in ${geo.state}` : "Pick a state first"}
          onChange={(city) => setGeo({ city })}
          disabled={!geo.state}
          options={cities.map((c) => ({ value: c.value, label: c.value, badge: c.count }))}
          className="w-[176px]"
        />

        <div className="ml-auto flex items-end gap-2">
          <p className="text-[12px] text-ink-2">
            <span className="num font-semibold text-ink">{scopedCount}</span>
            <span className="text-ink-3"> / {totalCount} carriers in scope</span>
          </p>
          {isFiltered && (
            <GhostButton tone="danger" onClick={clearFilters} title="Reset every filter and re-frame the map">
              Clear all
            </GhostButton>
          )}
        </div>
      </div>

      {(focus || ev === "non-ev") && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
          {focus && (
            <FilterChip onClear={() => setFocus(null)}>
              Map drill-down · {focus.label} · <span className="num">{focus.vehicleIds.length}</span> assets
            </FilterChip>
          )}
          {ev === "non-ev" && (
            <span className="rounded-md border border-info/30 bg-info-soft px-2 py-1 text-[12px] text-info">
              Non-EV telemetry integration pending — diesel carriers report position and odometer only.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
