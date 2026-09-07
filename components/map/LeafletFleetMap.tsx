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
 *
 * HOVER CARD (Google-Maps-style)
 * ------------------------------
 * Each marker handles `mouseover`/`mouseout` directly. One shared card is
 * positioned with `latLngToContainerPoint()` and GLUED to its marker by
 * writing `transform` on the map's `move`/`zoom` events — direct DOM writes,
 * so panning/animation costs zero React renders. The card's content is always
 * re-derived from the CURRENT `points` array by id, so a streaming SOC/GPS
 * update refreshes an open card in place, and a truck that drops out of the
 * feed closes the card instead of showing stale telemetry. A 90 ms close lag
 * stops the card from flickering while the cursor crosses gaps between
 * neighbouring markers.
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
 *   row hover     -> store.hover(id, "table") -> the map opens the same card
 *   marker click  -> store.select(id, "map")  -> card pins to the selection
 *   cluster click -> camera only — no store mutation of any kind.
 * Every marker subscribes to its own boolean via a Zustand selector, and both
 * marker kinds are `memo`-ised on a stable point object, so a hover re-renders
 * exactly two markers, not two hundred.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, GeoJSON, MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { GeoJsonObject } from "geojson";

import { useIsHovered, useIsSelected, useTwin } from "@/lib/store";
import { regionOfState } from "@/lib/fleet";
import { STATUS_SHORT, type AssetStatus } from "@/lib/fleet-metrics";
import { ZOOM, type MapCluster, type MapPoint } from "@/lib/map-data";

import "leaflet/dist/leaflet.css";

/** Below this zoom the map shows city clusters; above it, individual trucks. */
const CLUSTER_BREAK = 7;

/**
 * The deterministic resting frame: the whole of India. BOTH the mount frame
 * and every reset land here, so "Exit Live View" can never depend on what the
 * current (possibly narrowed) data happens to be.
 */
const INDIA_HOME = { center: [21.5, 79] as [number, number], zoom: ZOOM.fleet };

/** Desaturated status hues, matched to the design tokens. Markers sit on a
 *  photographic basemap, so they carry a solid white hairline for separation
 *  instead of a glow — a halo over map detail reads as a rendering artefact. */
const STATUS_COLOR: Record<AssetStatus, string> = {
  moving: "#4ca771",
  charging: "#4ca771",
  idle: "#8b8d94",
  unknown: "#6b7280",
};

/**
 * BASEMAP: OpenStreetMap standard raster tiles.
 *
 * CARTO's basemaps.cartocdn.com now returns an API-key error for
 * unauthenticated traffic, which is why the map surfaced "API KEY REQUIRED".
 * OSM's standard layer needs no key and no account — identical behaviour on a
 * laptop, a Vercel preview, or production.
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

type HoverRef = { kind: "point" | "cluster"; id: string };
type CardTarget =
  | { kind: "point"; point: MapPoint }
  | { kind: "cluster"; cluster: MapCluster };

const fmtCoord = (v: number, pos: "N" | "E", neg: "S" | "W") =>
  `${Math.abs(v).toFixed(4)}° ${v >= 0 ? pos : neg}`;

/**
 * The floating card. Mounted at most ONCE per map. Positioning is glued to the
 * anchor by projecting lat/lng -> container px on every map move and writing
 * `transform` straight to the DOM — no React state per frame, so a flyTo
 * animation or a pan costs nothing. Flips below the marker when there is no
 * room above (the flip is state, but only changes on the boundary frame).
 */
function HoverCard({ map, target }: { map: L.Map; target: CardTarget }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [below, setBelow] = useState(false);

  const lat = target.kind === "point" ? target.point.lat : target.cluster.lat;
  const lon = target.kind === "point" ? target.point.lon : target.cluster.lon;

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const GAP = 14; // marker edge -> card edge; leaves room for the arrow
    const EDGE = 8;
    const place = () => {
      const pt = map.latLngToContainerPoint([lat, lon]);
      const size = map.getSize();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = Math.min(Math.max(pt.x - w / 2, EDGE), Math.max(EDGE, size.x - w - EDGE));
      const nextBelow = pt.y - h - GAP < EDGE;
      const y = nextBelow ? pt.y + GAP : pt.y - h - GAP;
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      setBelow((prev) => (prev === nextBelow ? prev : nextBelow));
    };
    place();
    // `move` covers pan + flyTo frames, `zoom` the zoom animation, `resize`
    // viewport changes — all cheap DOM writes.
    map.on("move zoom resize viewreset", place);
    return () => {
      map.off("move zoom resize viewreset", place);
    };
  }, [map, lat, lon]);

  const arrow = (
    <span
      aria-hidden
      className={`absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-line-strong bg-surface ${
        below ? "-top-1 border-l border-t" : "-bottom-1 border-b border-r"
      }`}
    />
  );

  if (target.kind === "cluster") {
    const c = target.cluster;
    return (
      <div
        ref={cardRef}
        className="rise-in pointer-events-none absolute left-0 top-0 z-[900] w-[248px] will-change-transform"
      >
        <div className="relative rounded-xl border border-line-strong bg-surface/95 p-3 shadow-[0_10px_28px_rgba(0,0,0,0.4)] backdrop-blur-sm">
          {arrow}
          <p className="truncate text-[12.5px] font-semibold text-ink">
            {c.city}, {c.state}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-2">
            {regionOfState(c.state) ?? "Unmapped region"} region
          </p>
          <div className="my-2 h-px bg-line" />
          <p className="text-[11px] text-ink-2">
            <span className="num font-semibold text-ink">{c.count}</span>{" "}
            {c.count === 1 ? "carrier" : "carriers"} in this cluster
          </p>
          <p className="mt-0.5 text-[11px] text-ink-2">
            Avg SOC <span className="num">{c.avgSoc === null ? "—" : `${c.avgSoc}%`}</span>
          </p>
          <p className="mt-2 text-[11px] font-medium text-accent">
            Click to zoom in — every other carrier stays on the map
          </p>
        </div>
      </div>
    );
  }

  const p = target.point;
  const color = STATUS_COLOR[p.status];
  return (
    <div
      ref={cardRef}
      className="rise-in pointer-events-none absolute left-0 top-0 z-[900] w-[248px] will-change-transform"
    >
      <div className="relative rounded-xl border border-line-strong bg-surface/95 p-3 shadow-[0_10px_28px_rgba(0,0,0,0.4)] backdrop-blur-sm">
        {arrow}
        {/* identity: human label + status, exactly like a Maps place card */}
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-[12.5px] font-semibold text-ink">
            {p.batteryLabel ?? p.chassis}
          </p>
          <span
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ color, borderColor: `${color}55`, background: `${color}1f` }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
            {STATUS_SHORT[p.status]}
          </span>
        </div>
        <p className="num mt-0.5 truncate text-[10.5px] text-ink-3">
          ID {p.vehicleId}
          {p.batteryLabel ? ` · ${p.chassis}` : ""}
        </p>

        <div className="my-2 h-px bg-line" />

        {/* live location */}
        <p className="truncate text-[11.5px] text-ink-2">
          <span className="font-semibold text-ink">{p.city ?? "Unmapped"}</span>
          {p.state ? `, ${p.state}` : ""}
        </p>
        <p className="num mt-0.5 text-[10.5px] text-ink-3">
          {fmtCoord(p.lat, "N", "S")}, {fmtCoord(p.lon, "E", "W")}
        </p>

        {/* live vitals */}
        {p.soc !== null && (
          <div className="mt-2">
            <div className="flex items-baseline justify-between text-[10.5px] text-ink-3">
              <span className="font-semibold tracking-[0.08em]">SOC</span>
              <span className="num text-ink-2">{p.soc}%</span>
            </div>
            <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.min(100, Math.max(0, p.soc))}%`, background: color }}
              />
            </div>
          </div>
        )}
        <p className="mt-2 text-[10px] uppercase tracking-[0.08em] text-ink-3">{p.ageLabel}</p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- markers */

const VehicleMarker = memo(function VehicleMarker({
  point,
  onHoverIn,
  onHoverOut,
}: {
  point: MapPoint;
  onHoverIn: (kind: "point" | "cluster", id: string) => void;
  onHoverOut: () => void;
}) {
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
        // onMouseOver -> the floating card + the table-row highlight link.
        mouseover: () => {
          hover(point.vehicleId, "map");
          onHoverIn("point", point.vehicleId);
        },
        mouseout: () => {
          hover(null);
          onHoverOut();
        },
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

/** City aggregate: a divIcon so the count is real text, not a canvas glyph. */
const ClusterMarker = memo(function ClusterMarker({
  cluster,
  onDrill,
  onHoverIn,
  onHoverOut,
}: {
  cluster: MapCluster;
  onDrill: (c: MapCluster) => void;
  onHoverIn: (kind: "point" | "cluster", id: string) => void;
  onHoverOut: () => void;
}) {
  const icon = useMemo(() => {
    const size = Math.min(64, 34 + Math.round(Math.sqrt(cluster.count) * 5));
    return L.divIcon({
      className: "",
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      // Neutral, not accent. A city aggregate is a navigational affordance,
      // not a call to action.
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
      eventHandlers={{
        // CLICK = ZOOM ONLY. This handler is the cluster-fix in one line: it
        // never touches the store's geo/focus filters, so the other trucks
        // stay rendered while the camera flies in.
        click: () => onDrill(cluster),
        mouseover: () => onHoverIn("cluster", cluster.id),
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
  // Row hover / deep links surface the same card on the map (origin "table"),
  // and a click pins it. Read here — NOT per marker — so markers stay memo'd.
  const tableHoveredId = useTwin((s) => (s.hovered?.origin === "table" ? s.hovered.vehicleId : null));
  const selectedId = useTwin((s) => s.selected?.vehicleId ?? null);

  const [zoom, setZoom] = useState<number>(ZOOM.fleet);
  /**
   * The Leaflet map instance lives in STATE, not a ref: the hover card needs
   * it while rendering, and React's rules forbid reading a ref during render.
   * The callback ref below fires during the mount commit — long before any
   * marker event can open the card.
   */
  const [map, setMap] = useState<L.Map | null>(null);
  const mapRef = useCallback((instance: L.Map | null) => setMap(instance), []);

  /** Cursor-driven card target. A short close-lag stops flicker while the
   *  cursor crosses the gaps between neighbouring markers. */
  const [hover, setHover] = useState<HoverRef | null>(null);
  const closeTimer = useRef<number | null>(null);

  const onHoverIn = useCallback((kind: "point" | "cluster", id: string) => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setHover({ kind, id });
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
   * Zoom events may not be followed by a `mouseout` — crossing CLUSTER_BREAK
   * swaps the cluster layer for truck markers, and the unmounted bubble can
   * never report the cursor leaving. So the zoom subscriber itself retires a
   * stale cluster hover. (Functional update keeps it a no-op otherwise, and
   * keeps this out of render/effect territory entirely.)
   */
  const onZoomChange = useCallback((z: number) => {
    setZoom(z);
    setHover((h) => (h?.kind === "cluster" && z >= CLUSTER_BREAK ? null : h));
  }, []);

  /**
   * The card always renders the CURRENT telemetry for its target: a streaming
   * SOC/GPS update refreshes the open card in place, and a target that drops
   * out of the feed closes the card rather than showing stale data.
   * Priority: cursor > row-hover link > pinned selection.
   */
  const cardTarget: CardTarget | null = useMemo(() => {
    const pointById = (id: string): CardTarget | null => {
      const p = points.find((v) => v.vehicleId === id);
      return p ? { kind: "point", point: p } : null;
    };
    if (hover) {
      if (hover.kind === "cluster") {
        const c = clusters.find((v) => v.id === hover.id);
        return c ? { kind: "cluster", cluster: c } : null;
      }
      return pointById(hover.id);
    }
    if (tableHoveredId) {
      const t = pointById(tableHoveredId);
      if (t) return t;
    }
    if (selectedId) return pointById(selectedId);
    return null;
  }, [hover, clusters, points, tableHoveredId, selectedId]);

  /**
   * DEMO INSURANCE: raster tiles come from a CDN, and conference wifi (or a
   * locked-down corporate proxy) blocks CDNs more often than anyone admits.
   * On the first `tileerror` we lazily pull the vendored MIT-licensed India
   * boundary geometry and draw it as a vector basemap, so the map degrades to
   * "real surveyed borders + live markers" instead of a grey rectangle.
   * The 300 KB GeoJSON is imported ONLY on that failure path, so the happy
   * path never pays for it.
   */
  interface Fallback {
    geo: GeoJsonObject;
    /** Concrete colours, resolved ONCE from the dark canvas scope. */
    stroke: string;
    fill: string;
  }
  const [fallbackGeo, setFallbackGeo] = useState<Fallback | null>(null);
  const tileErrorRef = useRef(false);
  const onTileError = () => {
    if (tileErrorRef.current) return;
    tileErrorRef.current = true;
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
  };

  const center = useMemo<[number, number]>(() => {
    if (points.length === 0) return INDIA_HOME.center;
    const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
    return [lat, lon];
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

  return (
    // `canvas-dark` scopes the dark token set to the map only: the overlay
    // chrome (zoom buttons, legend, Exit Live View) and the hover card all
    // inherit it, and the OSM tile inversion filter keys off the same class.
    // The surrounding page stays light.
    <div
      className={`canvas-dark relative ${heightClass} w-full overflow-hidden rounded-lg border border-line`}
      onMouseLeave={closeHoverNow}
    >
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
                onDrill={drill}
                onHoverIn={onHoverIn}
                onHoverOut={onHoverOut}
              />
            ))
          : points.map((p) => (
              <VehicleMarker key={p.vehicleId} point={p} onHoverIn={onHoverIn} onHoverOut={onHoverOut} />
            ))}
      </MapContainer>

      {/* Google-Maps-style hover card. z-[900]: Leaflet's panes top out at
          700, so the card always paints above markers and popups, and it is
          pointer-events-none so it can never trap the cursor. */}
      {cardTarget && map && (
        <HoverCard
          key={cardTarget.kind === "point" ? cardTarget.point.vehicleId : cardTarget.cluster.id}
          map={map}
          target={cardTarget}
        />
      )}

      {/* ----------------------------------------------------- map chrome */}
      {/* z-[1000]: Leaflet's markerPane (600) / popupPane (700) / controls
          (up to 1000) all sit inside `.leaflet-container`, which does not
          create its own stacking context — so at the old z-[500] a city
          bubble could paint OVER the Exit Live View button and swallow its
          clicks. Lifting the chrome above every pane makes the buttons
          clickable everywhere on the map. */}
      <div className="pointer-events-none absolute inset-0 z-[1000]">
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
