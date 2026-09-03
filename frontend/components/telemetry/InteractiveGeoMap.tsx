"use client";

/**
 * InteractiveGeoMap -- authentic India geo map + live location tracker.
 *
 * The surface is a real geographic map: 36 state/UT boundary polygons
 * (vendored, simplified MIT-licensed survey geometry -- see `lib/india-geo`)
 * rendered through the same camera as the fleet markers, with reference-city
 * anchors over the top.  Vehicles plot at their measured GPS fixes and are
 * styled by live state:
 *
 *   moving (speed > 0)        bright cyan marker + pulse ring
 *   parked, charging          amber marker
 *   parked                    slate marker
 *   speed not measured        hollow slate marker ("awaiting upstream")
 *
 * Two modes, driven by the global FilterContext:
 *
 *  1. Overview: every vehicle marker plus density bubbles for clusters of
 *     `CLUSTER_BUBBLE_MIN`+ assets.  Clicking a bubble (or a deployment
 *     candidate in the ranked list) sets `focus` -- a *global* filter -- which
 *     narrows the asset sidebar on the host page and switches this map into…
 *
 *  2. Live tracking: the camera flies to the focused assets and each truck
 *     renders as an animated marker (smooth, sensor-style motion emulated
 *     around its last validated fix) with id, SOC and status styling.
 *
 * BI-DIRECTIONAL SELECTION
 * -----------------------
 * Clicking (or keyboard-activating) any marker calls `selectVehicle(id,
 * "map")`: the host page selects that asset, opens its parameter view and
 * scrolls its card into view.  Conversely, selecting an asset in a list
 * (`origin: "list"`) flies this map's camera to the truck and rings its
 * marker.  Selection is a pointer, not a filter -- nothing is narrowed.
 *
 * CAMERA CONTRACT
 * ---------------
 * The viewport is a first-class camera, not a derived value.  All transitions
 * run through `useSmoothCamera`, an eased `flyTo` controller:
 *
 *   * Targets are computed from *validated* fixes only and quantised to
 *     ~10^-3 deg (~110 m).  Live GPS jitter can therefore never retrigger a
 *     camera move, let alone oscillate one.
 *   * Mode changes (overview <-> focus <-> single-asset flight) tween the
 *     camera centre and span over a fixed 800 ms `easeInOutCubic` flight.
 *     The camera is never swapped discontinuously, so selection can't
 *     "spazz" the viewport.
 *   * The boundary layer rides the camera through ONE group transform
 *     (degree-space path data, linear equirectangular camera), so flights
 *     never re-project geometry and can neither shake nor NaN it.
 *   * The emulated sensor drift is applied *after* projection and is invisible
 *     to the camera: during tracking the frame is locked, padded and stable
 *     while markers animate inside it.
 *   * `prefers-reduced-motion` snaps instead of flying.
 *
 * Geometry honesty is inherited from `trusted-telemetry`: only measured
 * latitude/longitude is plotted; out-of-bbox fixes are excluded, never faked.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { batteryRegistry, type BatteryIdentity } from "@/lib/fleet";
import { useFilters } from "@/lib/FilterContext";
import { indiaStatePaths } from "@/lib/india-geo";
import {
  INDIA_BBOX,
  REFERENCE_CITIES,
  buildClusters,
  geoPoints,
  type Cluster,
  type GeoPoint,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";

const CARD = "rounded-2xl border border-white/[0.06] bg-slate-900/40 backdrop-blur-md";
const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500";
const HAIRLINE = "h-px bg-white/[0.06]";

/* --------------------------------------------------------------- camera */

interface Camera {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

interface Viewport extends Camera {
  width: number;
  height: number;
}

const CANVAS_WIDTH = 1000;
const FLY_DURATION_MS = 800;

/** Minimum lon/lat span (deg) so a single fix or a tight cluster can never
 *  pin the camera at an absurd zoom.  Focus frames sit slightly wider than
 *  overview cells to leave label room around the markers. */
const MIN_SPAN_OVERVIEW = 0.12;
const MIN_SPAN_FOCUS = 0.18;

/** Camera targets are quantised to 1e-3 deg (~110 m): telemetry updates that
 *  move the fleet bounds less than this never retrigger a flight. */
const TARGET_QUANTUM_DEG = 0.001;

const quantise = (v: number): number => Math.round(v / TARGET_QUANTUM_DEG) * TARGET_QUANTUM_DEG;

/**
 * Fit a camera to `points` with breathing room, clamped to minimum spans and
 * quantised so the target is a stable primitive, not a jittering float set.
 * Total over the empty set: a neutral frame, never NaN.
 */
const NEUTRAL_CAMERA: Camera = { lonMin: 73, lonMax: 93, latMin: 8, latMax: 28 };

function fitCamera(points: GeoPoint[], minSpan: number, padLonFrac: number, padLatFrac: number): Camera {
  if (points.length === 0) return NEUTRAL_CAMERA;
  let lonMin = Infinity;
  let lonMax = -Infinity;
  let latMin = Infinity;
  let latMax = -Infinity;
  for (const p of points) {
    if (p.lon < lonMin) lonMin = p.lon;
    if (p.lon > lonMax) lonMax = p.lon;
    if (p.lat < latMin) latMin = p.lat;
    if (p.lat > latMax) latMax = p.lat;
  }

  const lonSpan = Math.max(lonMax - lonMin, minSpan);
  const latSpan = Math.max(latMax - latMin, minSpan);
  const lonMid = (lonMin + lonMax) / 2;
  const latMid = (latMin + latMax) / 2;

  return {
    lonMin: quantise(lonMid - (lonSpan / 2) * (1 + padLonFrac)),
    lonMax: quantise(lonMid + (lonSpan / 2) * (1 + padLonFrac)),
    latMin: quantise(latMid - (latSpan / 2) * (1 + padLatFrac)),
    latMax: quantise(latMid + (latSpan / 2) * (1 + padLatFrac)),
  };
}

/** Standard smooth fly-to easing: slow in, fast through the middle, slow out. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Interpolate two cameras through their centre + span (a zoom-like flight),
 *  which keeps the motion anchored even when the aspect ratios differ. */
function interpolateCamera(from: Camera, to: Camera, t: number): Camera {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const fromLonMid = (from.lonMin + from.lonMax) / 2;
  const fromLatMid = (from.latMin + from.latMax) / 2;
  const toLonMid = (to.lonMin + to.lonMax) / 2;
  const toLatMid = (to.latMin + to.latMax) / 2;
  const lonMid = lerp(fromLonMid, toLonMid);
  const latMid = lerp(fromLatMid, toLatMid);
  const lonSpan = lerp(from.lonMax - from.lonMin, to.lonMax - to.lonMin);
  const latSpan = lerp(from.latMax - from.latMin, to.latMax - to.latMin);
  return { lonMin: lonMid - lonSpan / 2, lonMax: lonMid + lonSpan / 2, latMin: latMid - latSpan / 2, latMax: latMid + latSpan / 2 };
}

/**
 * flyTo controller.  Renders the interpolated camera every animation frame
 * while a flight is in progress and holds the target camera afterwards.
 * Repeat notifications of an equal target are no-ops (deep-compared via a
 * quantised key), so parent re-renders can never shake the camera.
 */
function useSmoothCamera(target: Camera): Camera {
  const [displayed, setDisplayed] = useState<Camera>(target);
  const displayedRef = useRef<Camera>(target);
  const appliedKeyRef = useRef<string>(cameraKey(target));
  const rafRef = useRef(0);

  useEffect(() => {
    const key = cameraKey(target);
    if (key === appliedKeyRef.current) return;
    appliedKeyRef.current = key;

    const from = displayedRef.current;

    const snap = () => {
      displayedRef.current = target;
      setDisplayed(target);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      snap();
      return;
    }

    cancelAnimationFrame(rafRef.current);
    const startedAt = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - startedAt) / FLY_DURATION_MS, 1);
      const camera = interpolateCamera(from, target, easeInOutCubic(t));
      displayedRef.current = camera;
      setDisplayed(camera);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);

  return displayed;
}

function cameraKey(c: Camera): string {
  return `${c.lonMin}|${c.lonMax}|${c.latMin}|${c.latMax}`;
}

/** Canvas viewport for the current camera.  Pure, continuous in the camera,
 *  so per-frame interpolation never produces discontinuous geometry. */
function viewportOf(camera: Camera): Viewport {
  const lonSpan = camera.lonMax - camera.lonMin;
  const midLat = (camera.latMin + camera.latMax) / 2;
  const cos = Math.max(Math.cos((midLat * Math.PI) / 180), 0.1);
  const rawHeight = (CANVAS_WIDTH * (camera.latMax - camera.latMin)) / (lonSpan * cos);
  return { ...camera, width: CANVAS_WIDTH, height: Math.max(Math.round(Math.min(rawHeight, CANVAS_WIDTH)), 1) };
}

function projector(view: Viewport) {
  return (lat: number, lon: number) => ({
    x: ((lon - view.lonMin) / (view.lonMax - view.lonMin)) * view.width,
    y: ((view.latMax - lat) / (view.latMax - view.latMin)) * view.height,
  });
}

/* ------------------------------------------------------- motion styling */

type MotionState = "moving" | "charging" | "parked" | "unknown";

/** Live state of one plotted fix.  `null` speed is honest unknown, not 0. */
function motionOf(p: GeoPoint): MotionState {
  if (p.speedKmh === null) return "unknown";
  if (p.speedKmh > 0) return "moving";
  return p.chargingStatus === 1 ? "charging" : "parked";
}

const MOTION_COLOR: Record<MotionState, string> = {
  moving: "#22d3ee",
  charging: "#fbbf24",
  parked: "#64748b",
  unknown: "#475569",
};

const MOTION_LABEL: Record<MotionState, string> = {
  moving: "Moving",
  charging: "Parked · charging",
  parked: "Parked",
  unknown: "Speed not measured",
};

/** Clusters of this size or larger render as a density bubble in overview
 *  (click drills into live tracking); smaller ones show individual markers. */
const CLUSTER_BUBBLE_MIN = 6;

function hashSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return h;
}

type Tier = "low" | "mid" | "high";
const tier = (count: number): Tier => (count >= 8 ? "high" : count >= 4 ? "mid" : "low");
const TIER_COLOR: Record<Tier, string> = { low: "#22d3ee", mid: "#fbbf24", high: "#fb7185" };

type Hover = { kind: "cluster"; cluster: Cluster; x: number; y: number } | { kind: "point"; point: GeoPoint; x: number; y: number } | null;

/* -------------------------------------------------------------- marker */

function VehicleMarker({
  point,
  x,
  y,
  label,
  selected,
  onHover,
  onLeave,
  onSelect,
}: {
  point: GeoPoint;
  x: number;
  y: number;
  label: string;
  selected: boolean;
  onHover: () => void;
  onLeave: () => void;
  onSelect: () => void;
}) {
  const motion = motionOf(point);
  const color = MOTION_COLOR[motion];
  return (
    <g
      className="cursor-pointer outline-none"
      role="button"
      tabIndex={0}
      aria-label={`${label} — ${MOTION_LABEL[motion]}, SOC ${point.soc === null ? "unknown" : `${point.soc}%`}. Activate to open in the asset list.`}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onFocus={onHover}
      onBlur={onLeave}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {motion === "moving" && (
        <circle cx={x} cy={y} r={6} fill="none" stroke={color} strokeWidth={1.5} opacity={0.8}>
          <animate attributeName="r" values="6;20" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.8;0" dur="1.6s" repeatCount="indefinite" />
        </circle>
      )}
      {selected && <circle cx={x} cy={y} r={9.5} fill="none" stroke="#f8fafc" strokeWidth={1.4} opacity={0.85} />}
      <circle
        cx={x}
        cy={y}
        r={selected ? 5.5 : 4.5}
        fill={color}
        fillOpacity={motion === "unknown" ? 0.3 : 0.95}
        stroke={motion === "unknown" ? color : "#031018"}
        strokeWidth={1.4}
      />
    </g>
  );
}

/* ----------------------------------------------------------------- map */

export default function InteractiveGeoMap({
  vehicles,
  batteryLabels,
}: {
  vehicles: TrustedVehicle[];
  /** Page-provided identity map (built over the FULL fleet) so "Battery N"
   *  labels never shift with this map's filter scope.  Falls back to a
   *  registry over the passed vehicles alone. */
  batteryLabels?: ReadonlyMap<string, BatteryIdentity>;
}) {
  const { focus, setFocus, selection, selectVehicle } = useFilters();
  const [hover, setHover] = useState<Hover>(null);
  /** Frame timestamp published by the rAF loop; 0 until live-tracking starts. */
  const [frameTime, setFrameTime] = useState(0);

  const fallbackLabels = useMemo(() => batteryRegistry(vehicles), [vehicles]);
  const labels = batteryLabels ?? fallbackLabels;

  const { points } = useMemo(() => geoPoints(vehicles), [vehicles]);
  const inRegion = useMemo(
    () =>
      points.filter(
        (p) => p.lat >= INDIA_BBOX.latMin && p.lat <= INDIA_BBOX.latMax && p.lon >= INDIA_BBOX.lonMin && p.lon <= INDIA_BBOX.lonMax,
      ),
    [points],
  );

  const clusters = useMemo(() => buildClusters(inRegion), [inRegion]);
  const candidates = useMemo(() => clusters.filter((c) => c.count >= 2), [clusters]);

  /** Dense cells become clickable density bubbles; the rest plot as
   *  individual status markers so every truck stays addressable. */
  const bubbles = useMemo(() => (focus ? [] : clusters.filter((c) => c.count >= CLUSTER_BUBBLE_MIN)), [clusters, focus]);
  const bubbleIds = useMemo(() => new Set(bubbles.flatMap((b) => b.members.map((m) => m.vehicleId))), [bubbles]);
  const overviewMarkers = useMemo(() => inRegion.filter((p) => !bubbleIds.has(p.vehicleId)), [inRegion, bubbleIds]);

  const focusMembers = useMemo(
    () => (focus ? inRegion.filter((p) => focus.vehicleIds.includes(p.vehicleId)) : []),
    [focus, inRegion],
  );

  const emphasis = focus ? focusMembers : inRegion;

  /** The asset the lists and the map are jointly pointing at. */
  const selectionPoint = useMemo(
    () => (selection ? (inRegion.find((p) => p.vehicleId === selection.vehicleId) ?? null) : null),
    [selection, inRegion],
  );

  /**
   * Camera target.  Overview pads by 12%/14%; focus pads wider (20%/26%) so
   * vehicle-id and SOC labels stay inside the frame.  A list-side selection
   * (no focus) flies to that single truck.  All are quantised by `fitCamera`,
   * and `useSmoothCamera` deep-compares, so neither live marker drift nor
   * parent re-renders can move the camera once framed.  A focus whose members
   * left the region falls back to the overview frame (the empty-state card
   * renders instead of the map).
   */
  const target = useMemo<Camera>(
    () =>
      focus && focusMembers.length > 0
        ? fitCamera(focusMembers, MIN_SPAN_FOCUS, 0.2, 0.26)
        : selection && selection.origin === "list" && selectionPoint
          ? fitCamera([selectionPoint], MIN_SPAN_FOCUS, 0.2, 0.26)
          : fitCamera(inRegion, MIN_SPAN_OVERVIEW, 0.12, 0.14),
    [focus, focusMembers, selection, selectionPoint, inRegion],
  );
  const camera = useSmoothCamera(target);
  const view = useMemo(() => viewportOf(camera), [camera]);
  const project = useMemo(() => projector(view), [view]);

  /** Degree-space boundary paths, compiled once; the camera rides one group
   *  transform (the projection is linear in lon/lat), so flights never
   *  re-project 19k coordinate pairs. */
  const statePaths = useMemo(() => indiaStatePaths(), []);
  const geoScaleX = view.width / (view.lonMax - view.lonMin);
  const geoScaleY = view.height / (view.latMax - view.latMin);
  const geoTransform = `translate(${-view.lonMin * geoScaleX} ${view.latMax * geoScaleY}) scale(${geoScaleX} ${-geoScaleY})`;

  // Sensor-style refresh while live-tracking: ~15 fps re-render.
  useEffect(() => {
    if (!focus) return;
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      if (ts - last > 66) {
        last = ts;
        setFrameTime(ts);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  if (inRegion.length === 0 || emphasis.length === 0) {
    return (
      <section className={`${CARD} px-6 py-14 text-sm text-slate-500`}>
        No measured latitude/longitude in the current filter scope — nothing to map without inventing geometry.
      </section>
    );
  }

  /** Read from the rAF loop's own timestamp, not `Date.now()`: render stays pure. */
  const now = frameTime;
  /** Emulated smooth motion around the last validated fix (live mode only).
   *  Applied strictly AFTER projection inputs are fixed: the camera never
   *  sees this drift, so tracking stays visually calm. */
  const livePosition = (p: GeoPoint) => {
    if (!focus) return { lat: p.lat, lon: p.lon };
    const seed = hashSeed(p.vehicleId);
    const amp = 0.0028;
    return {
      lat: p.lat + Math.sin(now / 1500 + seed) * amp,
      lon: p.lon + Math.cos(now / 1900 + seed * 1.31) * amp * 1.25,
    };
  };

  const drill = (cluster: Cluster) =>
    setFocus({
      id: cluster.id,
      label: `${cluster.city.name}, ${cluster.city.state}`,
      vehicleIds: cluster.members.map((m) => m.vehicleId),
    });

  const maxCount = clusters[0]?.count ?? 1;
  const bubbleRadius = (count: number) => 10 + Math.sqrt(count / maxCount) * 30;
  const visibleCities = REFERENCE_CITIES.filter(
    (c) => c.lat >= view.latMin && c.lat <= view.latMax && c.lon >= view.lonMin && c.lon <= view.lonMax,
  );

  const markerLayer = (members: GeoPoint[]) =>
    members.map((p) => {
      const pos = livePosition(p);
      const { x, y } = project(pos.lat, pos.lon);
      const label = labels.get(p.vehicleId)?.label ?? p.vehicleId;
      return (
        <g key={p.vehicleId}>
          <VehicleMarker
            point={p}
            x={x}
            y={y}
            label={label}
            selected={selection?.vehicleId === p.vehicleId}
            onHover={() => setHover({ kind: "point", point: p, x, y })}
            onLeave={() => setHover(null)}
            onSelect={() => selectVehicle(p.vehicleId, "map")}
          />
          {focus && (
            <>
              <text x={x + 9} y={y - 7} fill="#e2f4ff" fontSize="11" fontWeight="600" fontFamily="ui-sans-serif, system-ui" pointerEvents="none">
                {label}
              </text>
              <text x={x + 9} y={y + 6} fill="#7dd3fc" fontSize="10" fontFamily="ui-monospace, monospace" pointerEvents="none">
                {p.soc === null ? "SOC —" : `SOC ${p.soc}%`}
              </text>
            </>
          )}
        </g>
      );
    });

  return (
    <section className={CARD}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 pb-4 pt-6">
        <div>
          <p className={EYEBROW}>{focus ? "Live Location — Tracking Scope" : "Live Geography — India"}</p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight text-white">
            {focus ? `Tracking ${focusMembers.length} asset${focusMembers.length === 1 ? "" : "s"} — ${focus.label}` : "Live battery positions on the India map"}
          </h2>
        </div>
        {focus && (
          <button
            type="button"
            onClick={() => setFocus(null)}
            className="rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-[11px] font-medium text-cyan-200 transition hover:bg-cyan-400/20"
          >
            ← Exit live view
          </button>
        )}
      </header>

      <div className={HAIRLINE} />

      <div className="grid grid-cols-1 gap-6 p-6 xl:grid-cols-3">
        {/* ------------------------------------------------------ map surface */}
        <div className="xl:col-span-2">
          <div className="relative overflow-hidden rounded-2xl bg-[#03060d] ring-1 ring-white/[0.05]">
            <svg viewBox={`0 0 ${view.width} ${view.height}`} className="block h-auto w-full" role="group" aria-label="Interactive fleet map of India">
              {/* authentic state/UT boundaries, degree-space paths under one transform */}
              <g transform={geoTransform} aria-hidden>
                {statePaths.map((state) => (
                  <path
                    key={state.name}
                    d={state.d}
                    fill="#0b1626"
                    fillRule="evenodd"
                    stroke="#274361"
                    strokeWidth={1}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>

              {visibleCities.map((city) => {
                const { x, y } = project(city.lat, city.lon);
                return (
                  <g key={city.name} opacity={0.55} pointerEvents="none">
                    <path d={`M ${x - 4} ${y} H ${x + 4} M ${x} ${y - 4} V ${y + 4}`} stroke="#46586f" strokeWidth="1" />
                    <text x={x + 6} y={y + 3} fill="#8ea3bd" fontSize="11">{city.name}</text>
                  </g>
                );
              })}

              {/* overview: clickable density bubbles for the densest cells */}
              {!focus &&
                bubbles.map((cluster) => {
                  const { x, y } = project(cluster.lat, cluster.lon);
                  const color = TIER_COLOR[tier(cluster.count)];
                  const active = hover?.kind === "cluster" && hover.cluster.id === cluster.id;
                  return (
                    <g
                      key={cluster.id}
                      className="cursor-pointer"
                      onMouseEnter={() => setHover({ kind: "cluster", cluster, x, y })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => drill(cluster)}
                    >
                      <circle cx={x} cy={y} r={bubbleRadius(cluster.count)} fill={color} fillOpacity={active ? 0.32 : 0.12} stroke={color} strokeWidth={active ? 2.5 : 1.5} />
                      <text x={x} y={y + 4} textAnchor="middle" fill="#f8fafc" fontSize="13" fontWeight="600" fontFamily="ui-monospace, monospace">
                        {cluster.count}
                      </text>
                      <text x={x} y={y + bubbleRadius(cluster.count) + 14} textAnchor="middle" fill="#94a3b8" fontSize="11">
                        {cluster.city.name}
                      </text>
                    </g>
                  );
                })}

              {/* live markers: every addressable truck, styled by motion state */}
              {markerLayer(focus ? focusMembers : overviewMarkers)}
            </svg>

            {focus && (
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.08] px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-200 backdrop-blur-md">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                Live tracking · sensor emulation
              </div>
            )}

            {/* motion legend */}
            <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-white/[0.06] bg-slate-950/70 px-3 py-1.5 backdrop-blur-md">
              {(Object.keys(MOTION_LABEL) as MotionState[]).map((motion) => (
                <span key={motion} className="flex items-center gap-1.5 text-[10px] text-slate-400">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: MOTION_COLOR[motion], opacity: motion === "unknown" ? 0.45 : 1 }}
                  />
                  {MOTION_LABEL[motion]}
                </span>
              ))}
            </div>

            {hover && (
              <div
                className="pointer-events-none absolute z-10 w-60 -translate-x-1/2 -translate-y-full rounded-xl border border-white/10 bg-slate-950/90 p-3 text-[11px] shadow-2xl backdrop-blur-xl"
                style={{ left: `${(hover.x / view.width) * 100}%`, top: `${(hover.y / view.height) * 100 - 2}%` }}
              >
                {hover.kind === "cluster" ? (
                  <>
                    <p className="font-mono text-sm font-semibold text-white">{hover.cluster.count} assets</p>
                    <p className="text-slate-400">{hover.cluster.city.name}, {hover.cluster.city.state}</p>
                    <p className="mt-1 text-cyan-300">Click to drill down — the asset list narrows to these trucks</p>
                  </>
                ) : (
                  <>
                    <p className="truncate text-sm font-semibold text-white">
                      {labels.get(hover.point.vehicleId)?.label ?? hover.point.vehicleId}
                    </p>
                    <p className="truncate font-mono text-[10px] text-slate-500">
                      carrier {labels.get(hover.point.vehicleId)?.chassis ?? hover.point.vehicleId}
                    </p>
                    <p className="mt-1.5 flex items-center justify-between gap-2">
                      <span
                        className="rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.14em]"
                        style={{
                          color: MOTION_COLOR[motionOf(hover.point)],
                          background: `${MOTION_COLOR[motionOf(hover.point)]}1a`,
                        }}
                      >
                        {MOTION_LABEL[motionOf(hover.point)]}
                      </span>
                      <span className="font-mono text-base font-semibold text-cyan-300">
                        {hover.point.soc === null ? "SOC —" : `SOC ${hover.point.soc}%`}
                      </span>
                    </p>
                    <p className="mt-1 font-mono text-slate-500">{hover.point.lat.toFixed(4)}, {hover.point.lon.toFixed(4)}</p>
                    <p className="mt-1 text-cyan-300/80">Click to open this asset in the list</p>
                  </>
                )}
              </div>
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
            {focus
              ? "The camera flies to the selected scope and holds a locked, padded frame; markers interpolate smoothly around each truck's last validated GPS fix. Underlying coordinates are never fabricated beyond this visual drift."
              : "State boundaries are real surveyed geometry; every marker is a measured GPS fix, coloured by live motion state. Click a marker to open that asset in the list, or a density bubble to fly to the live location view."}
          </p>
        </div>

        {/* ---------------------------------------------- ranked candidates */}
        <div>
          <h3 className={EYEBROW}>Deployment Candidates</h3>
          <ol className="mt-4 space-y-2.5">
            {candidates.slice(0, 6).map((cluster, index) => (
              <li key={cluster.id}>
                <button
                  type="button"
                  onClick={() => drill(cluster)}
                  className="w-full rounded-xl border border-white/[0.06] bg-black/20 p-3 text-left transition hover:border-cyan-400/25 hover:bg-cyan-400/[0.05]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-sm text-white">
                      <span className="mr-2 text-slate-600">{String(index + 1).padStart(2, "0")}</span>
                      {cluster.count} assets
                    </p>
                    <span className="text-[10px] text-slate-500">{cluster.city.state}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {cluster.city.name} · avg SOC {cluster.avgSoc === null ? "—" : `${cluster.avgSoc}%`}
                  </p>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
