"use client";

/**
 * Real geographic fleet map — Leaflet tiles + live telemetry markers.
 *
 * CAMERA / DATA SEPARATION (the cluster-filter fix)
 * -------------------------------------------------
 * The original bug: clicking a cluster called `setGeo()` + `setFocus()` — two
 * NARROWING FILTERS in the shared store. The page derives `points` through
 * `applyVehicleFilters()`, so the marker array itself collapsed to that one
 * city; zooming out could not bring the other trucks back because the data,
 * not the camera, had been mutated. The contract is now:
 *
 *   cluster click  -> CAMERA ONLY. `flyToBounds()` over that cluster's
 *                     members, capped at ZOOM.cluster. The telemetry array is
 *                     never touched: every other truck stays rendered and
 *                     re-enters the viewport on any pan or zoom-out.
 *   marker click   -> select + one readable fly (ZOOM.asset). Selection is a
 *                     pointer, not a filter.
 *   filter bar     -> the ONLY thing allowed to narrow `points` (user intent,
 *                     upstream of this component).
 *   Exit Live View -> clears selection/hover/cluster state and performs ONE
 *                     deterministic flight to INDIA_HOME. Exactly one code
 *                     path moves the camera for a reset, so it cannot race
 *                     itself and cannot land anywhere but the wide frame.
 *   cursor leaves  -> MOUSE-LEAVE SNAP-BACK: after a 350 ms debounce the
 *                     camera glides home to the wide fleet overview, so a
 *                     zoomed-in frame is never left stranded. Re-entering
 *                     the map cancels the pending snap.
 *
 * HOVER OVERLAYS
 * --------------
 * Only city clusters expose a map-local hover card (region, carrier count,
 * average charge and density). Individual truck markers never mount a card;
 * their hover handler only highlights the matching carrier row. This hard
 * boundary prevents battery-context data from leaking into the truck map.
 *
 * ZOOM CONTRACT
 * -------------
 *   ZOOM.fleet   (5)  every asset in frame — the Exit Live View resting state
 *   ZOOM.cluster (9)  a city and its ring roads — where a cluster click lands
 *   ZOOM.asset   (11) ~15 km across — a truck plus its surroundings
 *   ZOOM.max     (15) the hard ceiling a user can reach manually.
 *
 * BI-DIRECTIONAL LINK
 * -------------------
 *   marker hover  -> store.hover(id, "map")   -> table row highlights
 *   row hover     -> store.hover(id, "table") -> marker highlights
 *   marker click  -> store.select(id, "map")  -> marker pins + camera flies
 *   cluster click -> camera only — no store mutation of any kind.
 * Every marker subscribes to its own boolean via a Zustand selector, and both
 * marker kinds are `memo`-ised on a stable point object, so a hover re-renders
 * exactly two markers, not two hundred.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GeoJSON, MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { GeoJsonObject } from "geojson";

import { useIsHovered, useIsSelected, useTwin } from "@/lib/store";
import { regionOfState } from "@/lib/fleet";
import { geographicCentroid } from "@/lib/gps";
import {
  HEAT_TIER_COLOR,
  HEAT_TIER_LABEL,
  ZOOM,
  densityTier,
  type HeatTier,
  type MapCluster,
  type MapPoint,
} from "@/lib/map-data";

import "leaflet/dist/leaflet.css";

/** Below this zoom the map shows city clusters; above it, individual trucks. */
const CLUSTER_BREAK = 7;

/**
 * The deterministic resting frame: the whole of India. BOTH the mount frame
 * and every reset land here, so "Exit Live View" can never depend on what the
 * current (possibly narrowed) data happens to be.
 */
const INDIA_HOME = { center: [21.5, 79] as [number, number], zoom: ZOOM.fleet };

/**
 * BASEMAP — a health-based failover chain, chosen for 2026 realities:
 *
 *   1. Esri World Dark Gray Canvas (primary). A NATIVE high-contrast dark
 *      basemap designed for enterprise data overlays — no CSS tricks, no API
 *      key, keyless on server.arcgisonline.com under Esri's basemap terms.
 *   2. OSM standard + CSS inversion (fallback). CARTO's dark raster began
 *      key-gating in late Aug 2026 (watermarked "API KEY REQUIRED"), so the
 *      dark variant of OSM is still produced in CSS (`.basemap-osm` filter in
 *      globals.css) — one warm cache, theme toggles never re-download tiles.
 *   3. Vendored India GeoJSON (offline). When every tile CDN is unreachable
 *      (conference wifi, locked-down proxies), the map degrades to surveyed
 *      vector borders + live markers instead of a grey rectangle.
 *
 * The first `tileerror` on a provider demotes it once; the GeoJSON layer only
 * mounts after the OSM tier has also failed. Attribution is REQUIRED by the
 * providers' terms and is rendered by the corner control.
 */
const BASEMAPS = {
  "esri-dark": {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
    maxNativeZoom: 16,
  },
  "osm-inverted": {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxNativeZoom: 19,
  },
} as const;

type Basemap = keyof typeof BASEMAPS;

/* ------------------------------------------------------------ camera glue */

function boundsOf(points: { lat: number; lon: number }[]): L.LatLngBounds | null {
  if (points.length === 0) return null;
  return L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
}

/**
 * Reads a design token off <html> as a concrete colour string.
 * Leaflet vector styles land in SVG presentation attributes, which do not
 * evaluate `var()` — passing the token through verbatim paints everything
 * black. Resolving here keeps the fallback basemap on-theme.
 */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  /**
   * Resolve against the DARK CANVAS element, not <html>.
   *
   * The map lives inside `.canvas-dark`, which re-declares the token set
   * locally. Reading from `document.documentElement` picks up the LIGHT page
   * values, which painted the offline basemap white-on-black. Always resolve
   * from an element that is actually inside the scope being drawn.
   */
  const host = document.querySelector(".canvas-dark") ?? document.documentElement;
  const value = getComputedStyle(host).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Camera controller. Owns every programmatic move so the zoom clamps live in
 * exactly one place, and so a reset is a SINGLE flight (the old button raced
 * the fit effect with two concurrent flyToBounds calls):
 *   1. `fitNonce` (Exit Live View / Clear filters) -> ONE flight to INDIA_HOME
 *   2. scope change (filter bar)  -> refit only if the new scope is not
 *      already on screen — telemetry churn (a truck dropping offline) can
 *      never yank the camera away from where the operator is looking
 *   3. `flyTo`   (row click / deep link) -> fly to ZOOM.asset, clamped
 */
function CameraController({ points }: { points: MapPoint[] }) {
  const map = useMap();
  const fitNonce = useTwin((s) => s.fitNonce);
  const flyTo = useTwin((s) => s.flyTo);
  const liveView = useTwin((s) => s.liveView);

  /** Identity of the current scope — a primitive, so the scope effect fires
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

  // 1. Explicit reframe command (Exit Live View, Clear filters). ONE flight,
  //    ONE destination: the wide-India resting frame. Deliberately independent
  //    of `points` so a narrowed dataset can never shrink the reset.
  useEffect(() => {
    map.flyTo(INDIA_HOME.center, INDIA_HOME.zoom, { duration: 0.7 });
  }, [fitNonce, map]);

  // 2. The filtered scope changed (filter bar only — cluster clicks no longer
  //    reach here by construction). Refit ONLY when the operator is not drilled
  //    into a live view AND the new scope is not already visible: if it is,
  //    hands off the camera entirely.
  useEffect(() => {
    if (firstScopeRun.current) {
      firstScopeRun.current = false; // the fitNonce effect already framed the mount
      return;
    }
    if (liveViewRef.current) return;
    const bounds = boundsOf(points);
    if (!bounds) return;
    const viewport = map.getBounds().pad(-0.05);
    if (viewport.contains(bounds)) return; // churn / already in frame: no move
    map.flyToBounds(bounds, {
      maxZoom: points.length === 1 ? ZOOM.asset : ZOOM.fleet + 1,
      padding: [40, 40],
      duration: 0.7,
    });
    // `points` is deliberately not a dependency: this effect answers scope
    // identity changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, map]);

  // 3. One-shot fly requested by a table row / alert / deep link. Clamped.
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

/* ------------------------------------------------------------- hover card */

type HoverRef = { id: string };

/** The tier label for a cluster hover card — vocabulary shared with the map legend. */
const hoverTierLabel = (tier: HeatTier) => HEAT_TIER_LABEL[tier];

/**
 * Cluster-only hover card. Individual truck markers intentionally never mount
 * a floating card: the Truck Telemetry map must not surface battery-context
 * data on pointer movement. The card is clipped by the isolated map frame and
 * follows its cluster through camera moves with direct DOM writes.
 */
function ClusterHoverCard({
  map,
  cluster,
  maxClusterCount,
}: {
  map: L.Map;
  cluster: MapCluster;
  maxClusterCount: number;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [below, setBelow] = useState(false);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const gap = 14;
    const edge = 8;
    const chrome = { w: 220, h: 58 };
    const place = () => {
      const point = map.latLngToContainerPoint([cluster.lat, cluster.lon]);
      const size = map.getSize();
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const margin = 80;
      const offscreen =
        point.x < -margin || point.x > size.x + margin || point.y < -margin || point.y > size.y + margin;
      el.style.visibility = offscreen ? "hidden" : "visible";
      if (offscreen) return;

      let left = Math.min(Math.max(point.x - width / 2, edge), Math.max(edge, size.x - width - edge));
      const nextBelow = point.y - height - gap < edge;
      let top = nextBelow ? point.y + gap : point.y - height - gap;
      if (left < chrome.w && top < chrome.h) {
        if (top + height < size.y - edge - (chrome.h - top)) top = chrome.h + 4;
        else left = chrome.w + 4;
      }
      el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      setBelow((current) => (current === nextBelow ? current : nextBelow));
    };

    place();
    map.on("move zoom resize viewreset", place);
    return () => {
      map.off("move zoom resize viewreset", place);
    };
  }, [cluster.lat, cluster.lon, map]);

  const tier = densityTier(cluster.count, maxClusterCount);
  const tierLabel = hoverTierLabel(tier);

  return (
    <div ref={cardRef} className="rise-in pointer-events-none absolute left-0 top-0 z-40 w-[248px] will-change-transform">
      <div className="relative rounded-xl border border-slate-300/70 bg-white/90 p-3 shadow-[0_8px_22px_rgba(2,6,23,0.3)]">
        <span
          aria-hidden
          className={`absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-slate-300/70 bg-white/90 ${
            below ? "-top-1 border-l border-t" : "-bottom-1 border-b border-r"
          }`}
        />
        <p className="truncate text-[12.5px] font-semibold text-slate-900">
          {cluster.city}, {cluster.state}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-500">
          {regionOfState(cluster.state) ?? "Unmapped region"} region
        </p>
        <div className="my-2 h-px bg-slate-200" />
        <p className="text-[11px] text-slate-600">
          <span className="num font-semibold text-slate-900">{cluster.count}</span>{" "}
          {cluster.count === 1 ? "carrier" : "carriers"} in this cluster
        </p>
        <p className="mt-0.5 text-[11px] text-slate-600">
          Average battery charge <span className="num">{cluster.avgSoc === null ? "—" : `${cluster.avgSoc}%`}</span>
          {"  ·  "}
          <span className="font-medium" style={{ color: HEAT_TIER_COLOR[tier] }}>{tierLabel}</span>
        </p>
        <p className="mt-2 text-[11px] font-semibold text-amber-700">
          Select to zoom in — all other carriers remain on the map
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- markers */

/** Pixel diameter of a cluster field: sqrt scaling (area ~ count). */
function clusterSize(count: number, maxCount: number): number {
  const ratio = maxCount > 0 ? count / maxCount : 0;
  return Math.round(Math.min(84, Math.max(40, 40 + Math.sqrt(ratio) * 34)));
}

/**
 * A single live truck = a LIGHT BLUE PULSING node (Google-Maps live-traffic
 * idiom). The pulse is a pure-CSS expanding ring on a divIcon — zero React
 * renders per frame, and `prefers-reduced-motion` stills it globally.
 * Hover only links the marker to its table row; it intentionally mounts no
 * tooltip or card on the truck-context map.
 */
const NODE_PX = 24;

const VehicleMarker = memo(function VehicleMarker({ point }: { point: MapPoint }) {
  const hovered = useIsHovered(point.vehicleId);
  const selected = useIsSelected(point.vehicleId);
  const hover = useTwin((s) => s.hover);
  const select = useTwin((s) => s.select);
  const requestFly = useTwin((s) => s.requestFly);

  const active = hovered || selected;

  const icon = useMemo(
    () =>
      L.divIcon({
        className: "",
        iconSize: [NODE_PX, NODE_PX],
        iconAnchor: [NODE_PX / 2, NODE_PX / 2],
        // vehicleId is validated upstream against ^[A-Za-z0-9._-]{3,32}$ —
        // attribute-safe; no escaping needed.
        html: `<div class="live-node${active ? " is-active" : ""}" data-vehicle-id="${point.vehicleId}">
                 <span class="sr-only">Truck ${point.vehicleId}</span>
                 <span class="live-node-ring" aria-hidden></span>
                 <span class="live-node-core" aria-hidden></span>
               </div>`,
      }),
    [active, point.vehicleId],
  );

  return (
    <Marker
      position={[point.lat, point.lon]}
      icon={icon}
      keyboard
      eventHandlers={{
        // Marker hover is pointer linkage only. No individual-marker overlay
        // is created, so battery context cannot leak into this truck map.
        mouseover: () => hover(point.vehicleId, "map"),
        mouseout: () => hover(null),
        click: () => {
          select(point.vehicleId, "map");
          // Readable radius, never a rooftop dive. NO filtering — selection
          // is a pointer, the data array is untouched.
          requestFly(point.lat, point.lon, ZOOM.asset);
        },
      }}
    />
  );
});

/**
 * Deterministic phase offset for a cluster's radar pings, derived from the
 * cluster id: without it every city would pulse in lockstep (a metronome is
 * exactly the toy rhythm this overhaul removes). Negative delays start the
 * animation mid-cycle, so a freshly mounted field is already "sweeping".
 */
function pingDelay(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h % 36) / 10;
}

/**
 * City aggregate = a DENSITY RADAR cell, not a bubble.
 *
 * Three translucent layers only — a light tier-tinted halo that breathes and
 * two thin radar rings expanding outward, phase-shifted per cluster. NO count
 * text and NO solid core: an enterprise radar reads shape first, detail on
 * demand — the existing hover card carries the city, the exact count, the
 * average SOC and the tier. A city with a SINGLE carrier is one live truck,
 * so it renders in the same light-blue pulsing-node language as every other
 * lone asset instead of drawing a field around a dot.
 */
const ClusterMarker = memo(function ClusterMarker({
  cluster,
  maxCount,
  onDrill,
  onHoverIn,
  onHoverOut,
}: {
  cluster: MapCluster;
  maxCount: number;
  onDrill: (c: MapCluster) => void;
  onHoverIn: (id: string) => void;
  onHoverOut: () => void;
}) {
  const icon = useMemo(() => {
    if (cluster.count === 1) {
      return L.divIcon({
        className: "",
        iconSize: [NODE_PX, NODE_PX],
        iconAnchor: [NODE_PX / 2, NODE_PX / 2],
        html: `<div class="live-node" data-cluster-id="${cluster.id}">
                 <span class="sr-only">One-carrier city location</span>
                 <span class="live-node-ring" aria-hidden></span>
                 <span class="live-node-core" aria-hidden></span>
               </div>`,
      });
    }
    const size = clusterSize(cluster.count, maxCount);
    const tier = densityTier(cluster.count, maxCount);
    return L.divIcon({
      className: "",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: `<div class="heat-blob heat-${tier}" style="width:${size}px;height:${size}px;--ping-delay:-${pingDelay(cluster.id)}s" data-cluster-id="${cluster.id}">
               <span class="sr-only">City cluster with ${cluster.count} carriers</span>
               <span class="heat-halo" aria-hidden></span>
               <span class="heat-center" aria-hidden></span>
               <span class="heat-ping" aria-hidden></span>
               <span class="heat-ping heat-ping-late" aria-hidden></span>
             </div>`,
    });
  }, [cluster, maxCount]);

  return (
    <Marker
      position={[cluster.lat, cluster.lon]}
      icon={icon}
      eventHandlers={{
        // CLICK = ZOOM ONLY. This handler is the cluster-fix in one line: it
        // never touches the store's geo/focus filters, so the other trucks
        // stay rendered while the camera flies in.
        click: () => onDrill(cluster),
        mouseover: () => onHoverIn(cluster.id),
        mouseout: onHoverOut,
      }}
    />
  );
});

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
  const exitLiveView = useTwin((s) => s.exitLiveView);
  const liveView = useTwin((s) => s.liveView);
  const [zoom, setZoom] = useState<number>(ZOOM.fleet);
  /**
   * The Leaflet map instance lives in STATE, not a ref: the hover card needs
   * it while rendering, and React's rules forbid reading a ref during render.
   * The callback ref below fires during the mount commit — long before any
   * marker event can open the card.
   */
  const [map, setMap] = useState<L.Map | null>(null);
  const mapRef = useCallback((instance: L.Map | null) => setMap(instance), []);
  /** Stable read for the snap-back timer, which must not re-bind on mount. */
  const mapRefCurrent = useRef<L.Map | null>(null);
  useEffect(() => {
    mapRefCurrent.current = map;
  }, [map]);

  /** Cursor-driven card target. A short close-lag stops flicker while the
   *  cursor crosses the gaps between neighbouring markers. */
  const [hover, setHover] = useState<HoverRef | null>(null);
  const closeTimer = useRef<number | null>(null);

  const onHoverIn = useCallback((id: string) => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHover({ id });
  }, []);

  const onHoverOut = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setHover(null);
    }, 90);
  }, []);

  const closeHoverNow = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHover(null);
  }, []);

  useEffect(() => closeHoverNow, [closeHoverNow]);

  /**
   * MOUSE-LEAVE SNAP-BACK (fleet-overview guarantee)
   *
   * When the cursor physically leaves the map container, the camera glides
   * back to the default wide fleet frame — an operator who drifts off the map
   * (or wheel-zooms into one city and leaves) never strands the overview for
   * the next person at the console. Mechanics:
   *
   *   * 350 ms debounce — brushing the border or the legend must not yank
   *     the camera; a genuine exit does.
   *   * re-entering cancels the pending snap (the operator came back).
   *   * fires ONLY from a drifted frame (zoom above the fleet level, or a
   *     live drill-down) — an overview already at home never animates.
   *   * reads the map + store imperatively at fire time, so the callback
   *     stays stable without mirroring liveView into another ref.
   *   * hover state is closed immediately either way (existing contract).
   */
  const snapTimer = useRef<number | null>(null);
  const cancelSnapBack = useCallback(() => {
    if (snapTimer.current !== null) {
      window.clearTimeout(snapTimer.current);
      snapTimer.current = null;
    }
  }, []);
  const onMouseLeaveMap = useCallback(() => {
    closeHoverNow();
    cancelSnapBack();
    snapTimer.current = window.setTimeout(() => {
      snapTimer.current = null;
      const instance = mapRefCurrent.current;
      if (!instance) return;
      if (instance.getZoom() <= ZOOM.fleet && !useTwin.getState().liveView) return;
      instance.flyTo(INDIA_HOME.center, INDIA_HOME.zoom, { duration: 0.9 });
    }, 350);
  }, [closeHoverNow, cancelSnapBack]);
  useEffect(() => cancelSnapBack, [cancelSnapBack]);

  /**
   * Zoom events may not be followed by a `mouseout` — crossing CLUSTER_BREAK
   * swaps the cluster layer for truck markers, and the unmounted bubble can
   * never report the cursor leaving. So the zoom subscriber itself retires a
   * stale cluster hover. (Functional update keeps it a no-op otherwise, and
   * keeps this out of render/effect territory entirely.)
   */
  const onZoomChange = useCallback((z: number) => {
    setZoom(z);
    setHover((current) => (current && z >= CLUSTER_BREAK ? null : current));
  }, []);

  /** Only aggregate clusters may own map overlays. */
  const hoveredCluster = useMemo(() => {
    if (!hover) return null;
    const cluster = clusters.find((item) => item.id === hover.id) ?? null;
    // A one-carrier city is still an individual asset, not a legitimate
    // aggregate. It gets the same zero-tooltip contract as every truck node.
    return cluster && cluster.count > 1 ? cluster : null;
  }, [clusters, hover]);

  /**
   * DEMO INSURANCE, tiered: see BASEMAPS. `failed` accumulates demoted
   * providers; the vendored GeoJSON mounts only after BOTH tile tiers failed.
   */
  interface Fallback {
    geo: GeoJsonObject;
    /** Concrete colours, resolved ONCE from the dark canvas scope. */
    stroke: string;
    fill: string;
  }
  const [fallbackGeo, setFallbackGeo] = useState<Fallback | null>(null);
  const [basemap, setBasemap] = useState<Basemap>("esri-dark");
  const demotedRef = useRef<Set<Basemap>>(new Set());
  const onTileError = () => {
    if (basemap === "esri-dark" && !demotedRef.current.has("esri-dark")) {
      demotedRef.current.add("esri-dark");
      setBasemap("osm-inverted");
      return;
    }
    if (basemap === "osm-inverted" && demotedRef.current.size >= 1 && !fallbackGeo) {
      import("@/data/india_states.json")
        .then((mod) =>
          setFallbackGeo({
            geo: (mod.default ?? mod) as unknown as GeoJsonObject,
            // Resolved here, in an event handler, rather than during render:
            // the DOM exists, so `.canvas-dark` is present and the tokens
            // resolve to the DARK set. React 19 also forbids reading refs
            // during render, which rules out doing this inline in the style.
            stroke: cssVar("--line-strong", "rgba(255,255,255,0.16)"),
            fill: cssVar("--surface-3", "#202127"),
          }),
        )
        .catch(() => undefined);
    }
  };

  const center = useMemo<[number, number]>(() => {
    const centroid = geographicCentroid(points);
    return centroid ? [centroid.lat, centroid.lon] : INDIA_HOME.center;
  }, [points]);

  /**
   * Cluster drill-down = CAMERA ONLY. No `setGeo`, no `setFocus`, no store
   * mutation of any kind — the original bug hid every other truck because
   * this path used to filter the shared dataset. The camera flies to the
   * cluster's members at a readable city radius; zooming out or panning
   * brings all the other trucks straight back into view.
   */
  const drill = useCallback(
    (cluster: MapCluster) => {
      if (!map) return;
      const memberIds = new Set(cluster.vehicleIds);
      const bounds = boundsOf(points.filter((p) => memberIds.has(p.vehicleId)));
      if (bounds) map.flyToBounds(bounds, { maxZoom: ZOOM.cluster, padding: [60, 60], duration: 0.8 });
      else map.flyTo([cluster.lat, cluster.lon], ZOOM.cluster, { duration: 0.8 });
    },
    [map, points],
  );

  const zoomBy = (delta: number) => {
    if (!map) return;
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, map.getZoom() + delta));
    map.flyTo(map.getCenter(), next, { duration: 0.3 });
  };

  /**
   * Exit Live View, wired end to end:
   *   a) clears selection/hover/cluster state (store pointers AND the local
   *      card target), and
   *   b) resets the viewport with ONE flight — the `fitNonce` effect below is
   *      the single camera path, and its destination is the fixed INDIA_HOME
   *      frame, so the reset cannot land on a narrowed dataset.
   */
  const onExitLiveView = () => {
    closeHoverNow();
    exitLiveView();
  };

  const showClusters = zoom < CLUSTER_BREAK && clusters.length > 0;
  /** Busiest city — the density palette self-calibrates against it. */
  const maxCount = useMemo(() => clusters.reduce((m, c) => Math.max(m, c.count), 0), [clusters]);

  return (
    // `canvas-dark` scopes the dark token set to the map only: the overlay
    // chrome (zoom buttons, legend, Exit Live View) and the hover card all
    // inherit it, and the OSM tile inversion filter keys off the same class.
    // The surrounding page stays light.
    <div
      className={`canvas-dark relative isolate z-0 ${heightClass} w-full overflow-hidden rounded-lg border border-line${
        basemap === "osm-inverted" ? " basemap-osm" : ""
      }`}
      role="region"
      aria-label="Interactive fleet map"
      onMouseLeave={onMouseLeaveMap}
      onMouseEnter={cancelSnapBack}
    >
      <MapContainer
        ref={mapRef}
        center={center}
        zoom={ZOOM.fleet}
        minZoom={ZOOM.min}
        maxZoom={ZOOM.max}
        zoomControl={false}
        scrollWheelZoom
        worldCopyJump
        className="relative z-0 h-full w-full"
        style={{ background: "var(--surface-3)" }}
      >
        {/* Keyed on the provider: a demotion swaps the layer cleanly instead
            of fighting a warm cache of failed URLs. On the OSM tier the dark
            variant is a CSS filter scoped to `.basemap-osm` (globals.css). */}
        <TileLayer
          key={basemap}
          url={BASEMAPS[basemap].url}
          attribution={BASEMAPS[basemap].attribution}
          maxZoom={ZOOM.max}
          maxNativeZoom={BASEMAPS[basemap].maxNativeZoom}
          eventHandlers={{ tileerror: onTileError }}
        />

        {/* Vector basemap — only mounted when the tile CDN is unreachable.
            NOTE: Leaflet writes these into SVG presentation attributes, where
            `var(--token)` does NOT resolve (it silently paints black). The
            tokens are therefore resolved to concrete colours in JS first. */}
        {fallbackGeo && (
          <GeoJSON
            data={fallbackGeo.geo}
            style={{ color: fallbackGeo.stroke, weight: 0.8, fillColor: fallbackGeo.fill, fillOpacity: 1 }}
          />
        )}
        <CameraController points={points} />
        <ZoomWatcher onZoom={onZoomChange} />

        {showClusters
          ? clusters.map((c) => (
              <ClusterMarker
                key={c.id}
                cluster={c}
                maxCount={maxCount}
                onDrill={drill}
                onHoverIn={onHoverIn}
                onHoverOut={onHoverOut}
              />
            ))
          : points.map((p) => <VehicleMarker key={p.vehicleId} point={p} />)}
      </MapContainer>

      {/* Aggregate hover detail only. The isolated, overflow-clipped map frame
          guarantees this overlay cannot bleed into surrounding page panels. */}
      {hoveredCluster && map && (
        <ClusterHoverCard
          key={hoveredCluster.id}
          map={map}
          cluster={hoveredCluster}
          maxClusterCount={maxCount}
        />
      )}

      {/* Map-local controls sit above Leaflet panes but below global dialogs. */}
      <div className="pointer-events-none absolute inset-0 z-30">
        {/* zoom cluster */}
        <div className="pointer-events-auto absolute right-3 top-3 flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[var(--shadow)]">
          <button
            type="button"
            onClick={() => zoomBy(1)}
            disabled={zoom >= ZOOM.max}
            aria-label="Zoom in"
            className="grid h-8 w-8 cursor-pointer place-items-center text-base font-semibold text-ink-2 transition hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            +
          </button>
          <span className="h-px bg-line" />
          <button
            type="button"
            onClick={() => zoomBy(-1)}
            disabled={zoom <= ZOOM.min}
            aria-label="Zoom out"
            className="grid h-8 w-8 cursor-pointer place-items-center text-base font-semibold text-ink-2 transition hover:bg-surface-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            −
          </button>
        </div>

        {/* exit live view — always visible, not only while drilled in, because
            the wheel can also take you somewhere unreadable */}
        <button
          type="button"
          onClick={onExitLiveView}
          className={`pointer-events-auto absolute left-3 top-3 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold shadow-[var(--shadow)] transition ${
            liveView || zoom > ZOOM.fleet + 1
              ? "border-accent/50 bg-accent text-white hover:brightness-110"
              : "border-line bg-surface text-ink-2 hover:bg-surface-3 hover:text-ink"
          }`}
          title="Reset the camera to the full-fleet frame and clear the map drill-down"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
            <path d="M7.5 2L4 6l3.5 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Exit Live View
        </button>

        {/* zoom read-out + layer state */}
        <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border border-line bg-surface/90 px-2 py-1 text-[10px] font-semibold tracking-[0.1em] text-ink-3">
          z<span className="num">{zoom}</span> · {showClusters ? "city clusters" : "assets"}
          {fallbackGeo && <span className="ml-1 text-warn">· offline basemap</span>}
        </div>

        {/* legend — live nodes + density tiers (status detail lives on the
            hover card; the map speaks two visual languages: pulsing = live,
            bubble colour = density) */}
        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface/95 px-2.5 py-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
            <span className="relative inline-flex h-2.5 w-2.5">
              <span className="absolute inset-0 rounded-full border border-[#63b3ff]" style={{ opacity: 0.55 }} />
              <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-[#63b3ff]" />
            </span>
            live node
          </span>
          {(["low", "medium", "high"] as const).map((t) => (
            <span key={t} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{
                  border: `1px solid ${HEAT_TIER_COLOR[t]}`,
                  background: `${HEAT_TIER_COLOR[t]}33`,
                }}
              />
              {hoverTierLabel(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
