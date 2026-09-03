"use client";

/**
 * Global filter state for the Trucks / Batteries pivot.
 *
 * A single React context mounted once in the root layout so the EV filter,
 * the cascading geography filter and the map drill-down focus all behave as
 * *global* state: clicking a heatmap cluster or a deployment candidate on any
 * page narrows every view, and the selection survives client-side navigation
 * between /, /trucks and /batteries.
 *
 * On top of the narrowing filters, the context carries the *asset selection*
 * (`selection` / `selectVehicle`) that makes the geo map and the asset lists
 * bi-directional: a marker click on the map selects the asset and scrolls its
 * card into view in the list (`origin: "map"`), and a list click flies the
 * map camera to that truck (`origin: "list"`).  Selection is a pointer, not a
 * filter -- it never narrows anything, so `isFiltered` ignores it.
 *
 * Deliberately Context + useState (no extra dependency); the state object is
 * small and the consumers are a handful of dashboard panels.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { AssetSelection, EvFilter, FilterState, FocusSelection, GeoSelection } from "@/lib/fleet";

interface FilterContextValue extends FilterState {
  setEv: (ev: EvFilter) => void;
  setGeo: (geo: Partial<GeoSelection>) => void;
  setFocus: (focus: FocusSelection | null) => void;
  clearAll: () => void;
  /** True when any narrowing is active (used to show a "filtered" chip). */
  isFiltered: boolean;
  /** The asset both the map and the lists are pointing at (null = none). */
  selection: AssetSelection | null;
  /** Point the whole dashboard at one asset; `origin` says who moved first. */
  selectVehicle: (vehicleId: string, origin: "map" | "list") => void;
  clearSelection: () => void;
}

const INITIAL: FilterState = { ev: "all", geo: { state: null, city: null }, focus: null };

const FilterContext = createContext<FilterContextValue | null>(null);

export function FilterProvider({ children }: { children: ReactNode }) {
  const [ev, setEvState] = useState<EvFilter>(INITIAL.ev);
  const [geo, setGeoState] = useState<GeoSelection>(INITIAL.geo);
  const [focus, setFocusState] = useState<FocusSelection | null>(INITIAL.focus);
  const [selection, setSelection] = useState<AssetSelection | null>(null);

  const setEv = useCallback((next: EvFilter) => setEvState(next), []);

  // Choosing a new state invalidates a previously selected city.
  const setGeo = useCallback((patch: Partial<GeoSelection>) => {
    setGeoState((prev) => {
      const next = { ...prev, ...patch };
      if (patch.state !== undefined && patch.state !== prev.state) next.city = null;
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setEvState(INITIAL.ev);
    setGeoState(INITIAL.geo);
    setFocusState(null);
  }, []);

  /** `seq` makes re-selecting the same asset observable (re-scroll, re-fly). */
  const selectVehicle = useCallback((vehicleId: string, origin: "map" | "list") => {
    setSelection((prev) => ({ vehicleId, origin, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const clearSelection = useCallback(() => setSelection(null), []);

  const value = useMemo<FilterContextValue>(
    () => ({
      ev,
      geo,
      focus,
      setEv,
      setGeo,
      setFocus: setFocusState,
      clearAll,
      isFiltered: ev !== "all" || geo.state !== null || geo.city !== null || focus !== null,
      selection,
      selectVehicle,
      clearSelection,
    }),
    [ev, geo, focus, setEv, setGeo, clearAll, selection, selectVehicle, clearSelection],
  );

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterContextValue {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useFilters must be used within <FilterProvider>");
  return ctx;
}
