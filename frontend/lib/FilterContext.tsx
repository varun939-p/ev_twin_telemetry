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
 * Deliberately Context + useState (no extra dependency); the state object is
 * small and the consumers are a handful of dashboard panels.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { EvFilter, FilterState, FocusSelection, GeoSelection } from "@/lib/fleet";

interface FilterContextValue extends FilterState {
  setEv: (ev: EvFilter) => void;
  setGeo: (geo: Partial<GeoSelection>) => void;
  setFocus: (focus: FocusSelection | null) => void;
  clearAll: () => void;
  /** True when any narrowing is active (used to show a "filtered" chip). */
  isFiltered: boolean;
}

const INITIAL: FilterState = { ev: "all", geo: { state: null, city: null }, focus: null };

const FilterContext = createContext<FilterContextValue | null>(null);

export function FilterProvider({ children }: { children: ReactNode }) {
  const [ev, setEvState] = useState<EvFilter>(INITIAL.ev);
  const [geo, setGeoState] = useState<GeoSelection>(INITIAL.geo);
  const [focus, setFocus] = useState<FocusSelection | null>(INITIAL.focus);

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
    setFocus(null);
  }, []);

  const value = useMemo<FilterContextValue>(
    () => ({
      ev,
      geo,
      focus,
      setEv,
      setGeo,
      setFocus,
      clearAll,
      isFiltered: ev !== "all" || geo.state !== null || geo.city !== null || focus !== null,
    }),
    [ev, geo, focus, setEv, setGeo, setFocus, clearAll],
  );

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterContextValue {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useFilters must be used within <FilterProvider>");
  return ctx;
}
