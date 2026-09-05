"use client";

/**
 * Real geographic fleet map — Leaflet tiles + live telemetry markers.
 *
 * WHY A TILE MAP REPLACED THE OLD SVG SURFACE
 * -------------------------------------------
 * The previous map was a hand-rolled SVG camera over vendored state polygons.
 * It looked geographic but behaved like a chart: no wheel zoom, no pan, and a
 * `fitCamera()` that framed a single fix at a ~0.18 deg span — the "zooms in
 * way too deep" bug, by construction.  This is a real slippy map: OSM/CARTO
 * raster tiles, real Mercator projection, wheel + pinch + keyboard zoom, and
 * every camera move clamped to a READABLE radius (see `ZOOM`).
 *
 * ZOOM CONTRACT (the deep-zoom fix)
 * ---------------------------------
 *   ZOOM.fleet   (5)  every asset in frame — the Exit Live View resting state
 *   ZOOM.cluster (9)  a city and its ring roads — where a cluster click lands
 *   ZOOM.asset   (11) ~15 km across — a truck plus its surroundings, never a
 *                     rooftop.  Marker clicks land here and NOWHERE deeper.
 *   ZOOM.max     (15) the hard ceiling a user can reach manually.
 * Programmatic moves always go through `flyToBounds(..., { maxZoom })` or a
 * literal target zoom, so no code path can dive past these numbers.
 *
 * BI-DIRECTIONAL LINK
 * -------------------
 *   marker hover  -> store.hover(id, "map")   -> table row highlights + scrolls
 *   row hover     -> store.hover(id, "table") -> marker grows + labels itself
 *   marker click  -> store.select(id, "map")  -> row opens, camera holds at 11
 *   cluster click -> store.setGeo({state, city}) — a real filter change, which
 *                    is what makes "Pune 29" narrow the table to Maharashtra /
 *                    Pune rather than merely panning.
 * Each marker subscribes to its own boolean via a Zustand selector, so moving
 * the pointer across the table re-renders two markers, not two hundred.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, GeoJSON, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { GeoJsonObject } from "geojson";

import { useIsHovered, useIsSelected, useTwin } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { STATUS_SHORT, type AssetStatus } from "@/lib/fleet-metrics";
import { ZOOM, type MapCluster, type MapPoint } from "@/lib/map-data";

import "leaflet/dist/leaflet.css";

/** Below this zoom the map shows city clusters; above it, individual trucks. */
const CLUSTER_BREAK = 7;

/** Desaturated status hues, matched to the design tokens. Markers sit on a
 *  photographic basemap, so they carry a solid white hairline for separation
 *  instead of a glow — a halo over map detail reads as a rendering artefact. */
const STATUS_COLOR: Record<AssetStatus, string> = {
  moving: "#4ca771",
  charging: "#5b67d8",
  idle: "#d9822b",
  unknown: "#8b8d94",
};

/**
 * BASEMAP: OpenStreetMap standard raster tiles.
 *
 * CARTO's basemaps.cartocdn.com now returns an API-key error for
 * unauthenticated traffic, which is why the map surfaced "API KEY REQUIRED".
 * OSM's standard layer needs no key and no account.
 *
 * One URL serves both themes. OSM only publishes a light cartography, so the
 * dark variant is produced in CSS (`.dark .leaflet-tile` in globals.css)
 * rather than by swapping tile servers — that keeps a single warm HTTP cache
 * and means toggling the theme never re-downloads 20 tiles.
 *
 * Attribution is REQUIRED by the OSM tile usage policy and is rendered by the
 * control in the corner; do not remove it.
 */
const TILES = {
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxNativeZoom: 19,
} as const;

/* ------------------------------------------------------------ camera glue */

function boundsOf(points: { lat: number; lon: number }[]): L.LatLngBounds | null {
  if (points.length === 0) return null;
  return L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
}

/**
 * Camera controller.  Owns every programmatic move so the zoom clamps live in
 * exactly one place:
 *   * `fitNonce` (Exit Live View / clear filters) -> refit the whole scope
 *   * `flyTo`    (a table row click)              -> fly to ZOOM.asset
 *   * scope change while not in live view          -> gentle refit
 */
/**
 * Reads a design token off <html> as a concrete colour string.
 * Leaflet vector styles land in SVG presentation attributes, which do not
 * evaluate `var()` — passing the token through verbatim paints everything
 * black. Resolving here keeps the fallback basemap on-theme.
 */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function CameraController({ points }: { points: MapPoint[] }) {
  const map = useMap();
  const fitNonce = useTwin((s) => s.fitNonce);
  const flyTo = useTwin((s) => s.flyTo);
  const liveView = useTwin((s) => s.liveView);

  /** Identity of the current scope — a primitive, so the effect below fires
   *  when the *set* of assets changes, not when the array is rebuilt. */
  const scopeKey = points.map((p) => p.vehicleId).join("|");

  /**
   * `liveView` must gate the refit WITHOUT being able to trigger one: drilling
   * into an asset flips it, and re-running the refit at that moment would yank
   * the camera straight back out.  Mirroring it into a ref from its own effect
   * (never during render) is the sanctioned way to read "latest value, don't
   * react to it".
   */
  const liveViewRef = useRef(liveView);
  useEffect(() => {
    liveViewRef.current = liveView;
  }, [liveView]);

  const firstScopeRun = useRef(true);
  const lastFlyRef = useRef(0);

  // 1. Explicit reframe request (Exit Live View, Clear filters). Always obeyed.
  useEffect(() => {
    const bounds = boundsOf(points);
    if (bounds) map.flyToBounds(bounds, { maxZoom: ZOOM.fleet, padding: [40, 40], duration: 0.7 });
    // `points` is deliberately not a dependency: this effect answers the
    // request, and effect 2 owns scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce, map]);

  // 2. The filtered scope changed. Refit ONLY when the operator is not drilled
  //    into a live view — otherwise a filter side-effect would move the camera
  //    away from the truck they are watching.
  useEffect(() => {
    if (firstScopeRun.current) {
      firstScopeRun.current = false; // effect 1 already framed the mount
      return;
    }
    if (liveViewRef.current) return;
    const bounds = boundsOf(points);
    if (bounds) {
      map.flyToBounds(bounds, {
        maxZoom: points.length === 1 ? ZOOM.asset : ZOOM.fleet + 1,
        padding: [40, 40],
        duration: 0.7,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, map]);

  // 3. One-shot fly requested by a table row / alert click. Clamped to ZOOM.max.
  useEffect(() => {
    if (!flyTo || flyTo.seq === lastFlyRef.current) return;
    lastFlyRef.current = flyTo.seq;
    map.flyTo([flyTo.lat, flyTo.lon], Math.min(flyTo.zoom, ZOOM.max), { duration: 0.7 });
  }, [flyTo, map]);

  return null;
}

/** Publishes the live zoom so the layer switch (clusters <-> trucks) is real. */
function ZoomWatcher({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({
    zoomend: () => onZoom(map.getZoom()),
  });
  useEffect(() => onZoom(map.getZoom()), [map, onZoom]);
  return null;
}

/* ----------------------------------------------------------------- markers */

function VehicleMarker({ point }: { point: MapPoint }) {
  const hovered = useIsHovered(point.vehicleId);
  const selected = useIsSelected(point.vehicleId);
  const hover = useTwin((s) => s.hover);
  const select = useTwin((s) => s.select);
  const requestFly = useTwin((s) => s.requestFly);

  const color = STATUS_COLOR[point.status];
  const active = hovered || selected;

  return (
    <CircleMarker
      center={[point.lat, point.lon]}
      radius={active ? 9 : 5.5}
      pathOptions={{
        color: active ? "#ffffff" : color,
        weight: active ? 2.5 : 1.5,
        fillColor: color,
        fillOpacity: point.status === "unknown" ? 0.35 : 0.9,
      }}
      eventHandlers={{
        mouseover: () => hover(point.vehicleId, "map"),
        mouseout: () => hover(null),
        click: () => {
          select(point.vehicleId, "map");
          // Readable radius, never a rooftop dive.
          requestFly(point.lat, point.lon, ZOOM.asset);
        },
        keypress: () => select(point.vehicleId, "map"),
      }}
    >
      <Tooltip direction="top" offset={[0, -8]} className="twin-tip" permanent={hovered && !selected}>
        <span className="block text-[12px] font-semibold text-ink">
          {point.batteryLabel ?? point.chassis}
        </span>
        <span className="block text-[11px] text-ink-2">
          {point.chassis} · {point.city ?? "unmapped"}
        </span>
        <span className="mt-1 block text-[11px]" style={{ color }}>
          {STATUS_SHORT[point.status]} · SOC {point.soc === null ? "—" : `${point.soc}%`}
        </span>
        <span className="block text-[10px] text-ink-3">{point.ageLabel}</span>
      </Tooltip>
    </CircleMarker>
  );
}

/** City aggregate: a divIcon so the count is real text, not a canvas glyph. */
function ClusterMarker({ cluster, onDrill }: { cluster: MapCluster; onDrill: (c: MapCluster) => void }) {
  const icon = useMemo(() => {
    const size = Math.min(64, 34 + Math.round(Math.sqrt(cluster.count) * 5));
    return L.divIcon({
      className: "",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      // Neutral, not accent. A city aggregate is a navigational affordance,
      // not a call to action, and 10 copper bubbles over a basemap was the
      // single loudest thing on the page.
      html: `<div style="width:${size}px;height:${size}px" class="grid place-items-center rounded-full border border-line-strong bg-surface/85 backdrop-blur-sm cursor-pointer transition hover:border-accent hover:bg-surface">
               <span class="num text-[13px] font-bold leading-none text-ink">${cluster.count}</span>
               <span class="text-[10px] font-medium text-ink-2 leading-none mt-0.5">${cluster.city}</span>
             </div>`,
    });
  }, [cluster.count, cluster.city]);

  return (
    <Marker
      position={[cluster.lat, cluster.lon]}
      icon={icon}
      eventHandlers={{ click: () => onDrill(cluster) }}
    >
      <Tooltip direction="top" offset={[0, -18]} className="twin-tip">
        <span className="block text-[12px] font-semibold text-ink">
          {cluster.count} assets · {cluster.city}, {cluster.state}
        </span>
        <span className="block text-[11px] text-ink-2">
          Avg SOC {cluster.avgSoc === null ? "—" : `${cluster.avgSoc}%`}
        </span>
        <span className="mt-1 block text-[11px] text-accent">
          Click to filter the table to {cluster.state} / {cluster.city}
        </span>
      </Tooltip>
    </Marker>
  );
}

/* -------------------------------------------------------------------- map */

export default function LeafletFleetMap({
  points,
  clusters,
  heightClass = "h-[460px]",
}: {
  points: MapPoint[];
  clusters: MapCluster[];
  heightClass?: string;
}) {
  const { resolved } = useTheme();

  const setGeo = useTwin((s) => s.setGeo);
  const setFocus = useTwin((s) => s.setFocus);
  const exitLiveView = useTwin((s) => s.exitLiveView);
  const liveView = useTwin((s) => s.liveView);

  const [zoom, setZoom] = useState<number>(ZOOM.fleet);
  const mapRef = useRef<L.Map | null>(null);

  /**
   * DEMO INSURANCE: raster tiles come from a CDN, and conference wifi (or a
   * locked-down corporate proxy) blocks CDNs more often than anyone admits.
   * On the first `tileerror` we lazily pull the vendored MIT-licensed India
   * boundary geometry and draw it as a vector basemap, so the map degrades to
   * "real surveyed borders + live markers" instead of a grey rectangle.
   * The 300 KB GeoJSON is imported ONLY on that failure path, so the happy
   * path never pays for it.
   */
  const [fallbackGeo, setFallbackGeo] = useState<GeoJsonObject | null>(null);
  const tileErrorRef = useRef(false);
  const onTileError = () => {
    if (tileErrorRef.current) return;
    tileErrorRef.current = true;
    import("@/data/india_states.json")
      .then((mod) => setFallbackGeo((mod.default ?? mod) as unknown as GeoJsonObject))
      .catch(() => undefined);
  };

  const center = useMemo<[number, number]>(() => {
    if (points.length === 0) return [21.5, 79];
    const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
    return [lat, lon];
  }, [points]);

  /**
   * Cluster drill-down = a FILTER change, per spec ("Pune 29" -> State =
   * Maharashtra, City = Pune) plus a focus scope so the table shows exactly
   * the trucks in that bubble.  The camera lands at ZOOM.cluster, which is a
   * city-wide radius — not the old "fit 4 points at 0.18 deg" dive.
   */
  const drill = (cluster: MapCluster) => {
    setGeo({ region: null, state: cluster.state, city: cluster.city });
    setFocus({
      id: cluster.id,
      label: `${cluster.city}, ${cluster.state}`,
      vehicleIds: cluster.vehicleIds,
    });
    const map = mapRef.current;
    if (!map) return;
    const bounds = boundsOf(points.filter((p) => cluster.vehicleIds.includes(p.vehicleId)));
    if (bounds) map.flyToBounds(bounds, { maxZoom: ZOOM.cluster, padding: [60, 60], duration: 0.8 });
    else map.flyTo([cluster.lat, cluster.lon], ZOOM.cluster, { duration: 0.8 });
  };

  const zoomBy = (delta: number) => {
    const map = mapRef.current;
    if (!map) return;
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, map.getZoom() + delta));
    map.flyTo(map.getCenter(), next, { duration: 0.3 });
  };

  const resetView = () => {
    exitLiveView();
    const map = mapRef.current;
    const bounds = boundsOf(points);
    if (map && bounds) map.flyToBounds(bounds, { maxZoom: ZOOM.fleet, padding: [40, 40], duration: 0.7 });
  };

  const showClusters = zoom < CLUSTER_BREAK && clusters.length > 0;

  return (
    <div className={`relative ${heightClass} w-full overflow-hidden rounded-lg border border-line`}>
      <MapContainer
        ref={mapRef}
        center={center}
        zoom={ZOOM.fleet}
        minZoom={ZOOM.min}
        maxZoom={ZOOM.max}
        zoomControl={false}
        scrollWheelZoom
        preferCanvas
        worldCopyJump
        className="h-full w-full"
        style={{ background: "var(--surface-3)" }}
      >
        {/* NOT keyed on the theme: one OSM layer serves both, and the dark
            variant is a CSS filter. Re-keying here would throw away the tile
            cache on every toggle. */}
        <TileLayer
          url={TILES.url}
          attribution={TILES.attribution}
          maxZoom={ZOOM.max}
          maxNativeZoom={TILES.maxNativeZoom}
          eventHandlers={{ tileerror: onTileError }}
        />

        {/* Vector basemap — only mounted when the tile CDN is unreachable.
            NOTE: Leaflet writes these into SVG presentation attributes, where
            `var(--token)` does NOT resolve (it silently paints black). The
            tokens are therefore resolved to concrete colours in JS first. */}
        {fallbackGeo && (
          <GeoJSON
            // Re-keyed on the theme so the vector fill/stroke are re-resolved
            // from the tokens when the palette flips.
            key={`fallback-${resolved}`}
            data={fallbackGeo}
            style={{
              color: cssVar("--line-strong", "#d4d4d8"),
              weight: 0.8,
              fillColor: cssVar("--surface-3", "#f4f4f5"),
              fillOpacity: 1,
            }}
          />
        )}
        <CameraController points={points} />
        <ZoomWatcher onZoom={setZoom} />

        {showClusters
          ? clusters.map((c) => <ClusterMarker key={c.id} cluster={c} onDrill={drill} />)
          : points.map((p) => <VehicleMarker key={p.vehicleId} point={p} />)}
      </MapContainer>

      {/* ----------------------------------------------------- map chrome */}
      <div className="pointer-events-none absolute inset-0 z-[500]">
        {/* zoom cluster */}
        <div className="pointer-events-auto absolute right-3 top-3 flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
          <button
            type="button"
            onClick={() => zoomBy(1)}
            aria-label="Zoom in"
            className="grid h-8 w-8 cursor-pointer place-items-center text-base font-semibold text-ink-2 transition hover:bg-surface-3 hover:text-ink"
          >
            +
          </button>
          <span className="h-px bg-line" />
          <button
            type="button"
            onClick={() => zoomBy(-1)}
            aria-label="Zoom out"
            className="grid h-8 w-8 cursor-pointer place-items-center text-base font-semibold text-ink-2 transition hover:bg-surface-3 hover:text-ink"
          >
            −
          </button>
        </div>

        {/* exit live view — always visible, not only while drilled in, because
            the wheel can also take you somewhere unreadable */}
        <button
          type="button"
          onClick={resetView}
          className={`pointer-events-auto absolute left-3 top-3 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold shadow-[var(--shadow)] transition ${
            liveView || zoom > ZOOM.fleet + 1
              ? "border-accent/50 bg-accent text-white hover:brightness-110"
              : "border-line bg-surface text-ink-2 hover:bg-surface-3 hover:text-ink"
          }`}
          title="Reset the camera to the full fleet frame and clear the map drill-down"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
            <path d="M7.5 2L4 6l3.5 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Exit Live View
        </button>

        {/* zoom read-out + layer state */}
        <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-line bg-surface/90 px-2 py-1 text-[10px] font-semibold tracking-[0.1em] text-ink-3 backdrop-blur-sm">
          z<span className="num">{zoom}</span> · {showClusters ? "city clusters" : "assets"}
          {fallbackGeo && <span className="ml-1 text-warn">· offline basemap</span>}
        </div>

        {/* legend */}
        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface/90 px-2.5 py-1.5 backdrop-blur-sm">
          {(["moving", "charging", "idle", "unknown"] as AssetStatus[]).map((s) => (
            <span key={s} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
              <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[s] }} />
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
