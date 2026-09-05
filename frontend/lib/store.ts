"use client";

/**
 * Global twin state (Zustand).
 *
 * WHY ZUSTAND OVER THE OLD CONTEXT
 * --------------------------------
 * The bi-directional map<->table link publishes a new value on every pointer
 * move over a marker or a row.  With a single React context that is a full
 * subtree re-render per mouse move: 100 table rows + 100 markers, ~60x/second.
 * Zustand lets each row subscribe to a *derived boolean* --
 * `useTwin((s) => s.hovered?.vehicleId === id)` -- so a hover re-renders
 * exactly two components (the row losing highlight and the row gaining it).
 *
 * STATE SHAPE
 * -----------
 *   filters    narrowing.  Everything downstream (map, table, KPIs, charts)
 *              is derived from this — never mirrored into local state.
 *   hovered    a POINTER, not a filter.  `origin` says who moved first so the
 *              receiving surface knows whether to scroll/flash.
 *   selected   sticky pointer set by a click; survives navigation, which is
 *              what makes the cross-page deep links feel instant.
 *   camera     an intent channel for the Leaflet map: `fitNonce` bumps when a
 *              consumer asks for "frame the whole fleet" (Exit Live View), and
 *              `flyTo` carries a one-shot target.  The map owns the actual
 *              zoom; the store never stores pixels.
 */

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import {
  regionOfState,
  type EvFilter,
  type FilterState,
  type FocusSelection,
  type GeoSelection,
  type SocBracket,
} from "@/lib/fleet";

export type PointerOrigin = "map" | "table" | "link";

export interface Pointer {
  vehicleId: string;
  origin: PointerOrigin;
  /** Increments on every publication so repeat pointers stay observable. */
  seq: number;
}

export interface FlyTarget {
  lat: number;
  lon: number;
  /** Readable radius, not a street-level dive. See MAP_ZOOM in FleetMap. */
  zoom: number;
  seq: number;
}

interface TwinState extends FilterState {
  hovered: Pointer | null;
  selected: Pointer | null;
  /** Bumped to command the map back to the full-fleet frame. */
  fitNonce: number;
  flyTo: FlyTarget | null;
  /** True while the map is drilled into a cluster / single asset. */
  liveView: boolean;

  setEv: (ev: EvFilter) => void;
  setGeo: (patch: Partial<GeoSelection>) => void;
  setSoc: (soc: SocBracket) => void;
  setStation: (stationId: string | null) => void;
  setFocus: (focus: FocusSelection | null) => void;

  hover: (vehicleId: string | null, origin?: PointerOrigin) => void;
  select: (vehicleId: string | null, origin?: PointerOrigin) => void;

  requestFly: (lat: number, lon: number, zoom: number) => void;
  /** The one true reset: clears drill-down + pointers and re-frames the map. */
  exitLiveView: () => void;
  clearFilters: () => void;
}

const INITIAL_GEO: GeoSelection = { region: null, state: null, city: null };

export const useTwin = create<TwinState>((set) => ({
  ev: "all",
  geo: INITIAL_GEO,
  focus: null,
  soc: "all",
  stationId: null,

  hovered: null,
  selected: null,
  fitNonce: 0,
  flyTo: null,
  liveView: false,

  setEv: (ev) => set({ ev }),

  /**
   * Cascade rules, enforced here rather than in three different dropdowns:
   *   region changed -> a state outside the new region is invalid, drop it
   *   state  changed -> city is invalid, drop it; region snaps to the state's
   *   city   changed -> nothing downstream to invalidate
   */
  setGeo: (patch) =>
    set((s) => {
      const next: GeoSelection = { ...s.geo, ...patch };
      if (patch.region !== undefined && patch.region !== s.geo.region) {
        if (next.state && regionOfState(next.state) !== patch.region) {
          next.state = null;
          next.city = null;
        }
      }
      if (patch.state !== undefined && patch.state !== s.geo.state) {
        next.city = null;
        if (patch.state) next.region = regionOfState(patch.state) ?? next.region;
      }
      return { geo: next };
    }),

  setSoc: (soc) => set({ soc }),
  setStation: (stationId) => set({ stationId }),
  setFocus: (focus) => set({ focus, liveView: focus !== null }),

  hover: (vehicleId, origin = "table") =>
    set((s) => {
      if (vehicleId === null) return s.hovered === null ? {} : { hovered: null };
      if (s.hovered?.vehicleId === vehicleId && s.hovered.origin === origin) return {};
      return { hovered: { vehicleId, origin, seq: (s.hovered?.seq ?? 0) + 1 } };
    }),

  select: (vehicleId, origin = "table") =>
    set((s) => {
      if (vehicleId === null) return { selected: null };
      return { selected: { vehicleId, origin, seq: (s.selected?.seq ?? 0) + 1 }, liveView: true };
    }),

  requestFly: (lat, lon, zoom) =>
    set((s) => ({ flyTo: { lat, lon, zoom, seq: (s.flyTo?.seq ?? 0) + 1 }, liveView: true })),

  exitLiveView: () =>
    set((s) => ({
      focus: null,
      selected: null,
      hovered: null,
      flyTo: null,
      liveView: false,
      fitNonce: s.fitNonce + 1,
    })),

  clearFilters: () =>
    set((s) => ({
      ev: "all",
      geo: INITIAL_GEO,
      soc: "all",
      stationId: null,
      focus: null,
      liveView: false,
      fitNonce: s.fitNonce + 1,
      // `selected` deliberately survives a filter clear: the operator is still
      // looking at that asset, they just widened the surrounding scope.
      hovered: null,
    })),
}));

/**
 * Snapshot of just the narrowing filters, for `applyVehicleFilters`.
 *
 * `useShallow` is mandatory here: the selector builds a fresh object every
 * call, and Zustand v5 compares snapshots with `Object.is`.  Without it React
 * would see a new snapshot on every store read and loop forever.
 */
export function useFilterState(): FilterState {
  return useTwin(
    useShallow((s) => ({ ev: s.ev, geo: s.geo, focus: s.focus, soc: s.soc, stationId: s.stationId })),
  );
}

/** True when anything is narrowing the fleet (drives the "filtered" chip). */
export function useIsFiltered(): boolean {
  return useTwin(
    (s) =>
      s.ev !== "all" ||
      s.geo.region !== null ||
      s.geo.state !== null ||
      s.geo.city !== null ||
      s.soc !== "all" ||
      s.stationId !== null ||
      s.focus !== null,
  );
}

/** Per-row subscription: re-renders only the two rows whose state flipped. */
export function useIsHovered(vehicleId: string): boolean {
  return useTwin((s) => s.hovered?.vehicleId === vehicleId);
}

export function useIsSelected(vehicleId: string): boolean {
  return useTwin((s) => s.selected?.vehicleId === vehicleId);
}
