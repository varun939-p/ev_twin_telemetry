/**
 * Authentic India geography for the interactive fleet map.
 *
 * The boundary geometry is a vendored, simplified extract of the MIT-licensed
 * `states_india.geojson` (https://github.com/mraxays/india-states.geojson,
 * (c) 2024 Mr Akshay Shinde -- see `frontend/data/india_states.LICENSE`):
 * 36 state/union-territory MultiPolygons, Douglas-Peucker simplified to
 * ~0.008 deg and rounded to 3 decimals (~110 m), ~19k coordinate pairs.
 * Real surveyed boundaries -- nothing about the coastline or the state
 * borders on the map is invented.
 *
 * Rendering model
 * ---------------
 * The map's camera is equirectangular and *linear* in lon/lat (see
 * `InteractiveGeoMap`), so the polygons are compiled ONCE into SVG path data
 * in raw degree-space and drawn inside a single `<g transform>` that maps
 * degrees onto the current viewport.  Camera flights therefore cost one
 * transform update, never a re-projection of 19k points -- no per-frame
 * string building, no jitter, no NaN paths.  Strokes stay hairline at every
 * zoom via `vector-effect: non-scaling-stroke`.
 *
 * This module is pure and React-free, like the rest of `lib/`.
 */

import geo from "@/data/india_states.json";

export interface IndiaGeometry {
  type: "MultiPolygon";
  /** [polygon][ring][point][lon|lat] */
  coordinates: number[][][][];
}

export interface IndiaFeature {
  type: "Feature";
  properties: { name: string };
  geometry: IndiaGeometry;
}

export interface IndiaFeatureCollection {
  type: "FeatureCollection";
  features: IndiaFeature[];
}

export const INDIA_GEO = geo as unknown as IndiaFeatureCollection;

/** Extent of the vendored geometry (deg). Used to keep the boundary layer
 *  cheaply cullable and to document what the map can show. */
export const INDIA_GEO_BBOX = {
  lonMin: 68.186,
  lonMax: 97.416,
  latMin: 6.755,
  latMax: 37.079,
} as const;

export interface IndiaStatePath {
  name: string;
  /** SVG path data in raw degree-space (x = lon, y = lat). */
  d: string;
}

/** Compile one feature's rings into degree-space path data.
 *  Rings are closed by the source; `evenodd` lets island groups and
 *  enclaves render correctly regardless of source winding order. */
export function featurePath(feature: IndiaFeature): string {
  let d = "";
  for (const polygon of feature.geometry.coordinates) {
    for (const ring of polygon) {
      if (ring.length < 2) continue;
      d += `M ${ring[0][0]} ${ring[0][1]}`;
      for (let i = 1; i < ring.length; i++) d += ` L ${ring[i][0]} ${ring[i][1]}`;
      d += " Z ";
    }
  }
  return d.trim();
}

/** All 36 state/UT paths, compiled once at module use (memoised by caller). */
export function indiaStatePaths(): IndiaStatePath[] {
  return INDIA_GEO.features.map((feature) => ({
    name: feature.properties.name,
    d: featurePath(feature),
  }));
}
