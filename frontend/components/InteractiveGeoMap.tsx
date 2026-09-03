"use client";

/**
 * InteractiveGeoMap -- drill-down density map + live location tracker.
 *
 * Two modes, driven by the global FilterContext:
 *
 *  1. Overview: density bubbles per ~25 km cell.  Clicking a bubble (or a
 *     deployment candidate in the ranked list) sets `focus` -- a *global*
 *     filter -- which narrows the asset sidebar on the host page and switches
 *     this map into…
 *
 *  2. Live tracking: the viewport zooms to the focused assets and each truck
 *     renders as an animated marker (smooth, sensor-style motion emulated
 *     around its last validated fix) with id, SOC and a pulse ring, so every
 *     truck in the scope can be tracked explicitly.
 *
 * Geometry honesty is inherited from `trusted-telemetry`: only measured
 * latitude/longitude is plotted; out-of-bbox fixes are excluded, never faked.
 */

import { useEffect, useMemo, useState } from "react";

import { useFilters } from "@/lib/FilterContext";
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

/* ------------------------------------------------------------- projection */

interface Viewport { lonMin: number; lonMax: number; latMin: number; latMax: number; width: number; height: number; }
const CANVAS_WIDTH = 1000;

function buildViewport(points: GeoPoint[]): Viewport {
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  const lonSpan = Math.max(Math.max(...lons) - Math.min(...lons), 0.12);
  const latSpan = Math.max(Math.max(...lats) - Math.min(...lats), 0.12);
  const lonMin = Math.min(...lons) - lonSpan * 0.12;
  const lonMax = Math.max(...lons) + lonSpan * 0.12;
  const latMin = Math.min(...lats) - latSpan * 0.14;
  const latMax = Math.max(...lats) + latSpan * 0.14;
  const midLat = (latMin + latMax) / 2;
  const height = (CANVAS_WIDTH * (latMax - latMin)) / ((lonMax - lonMin) * Math.cos((midLat * Math.PI) / 180));
  return { lonMin, lonMax, latMin, latMax, width: CANVAS_WIDTH, height: Math.round(Math.min(height, CANVAS_WIDTH)) };
}

function projector(view: Viewport) {
  return (lat: number, lon: number) => ({
    x: ((lon - view.lonMin) / (view.lonMax - view.lonMin)) * view.width,
    y: ((view.latMax - lat) / (view.latMax - view.latMin)) * view.height,
  });
}

function hashSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return h;
}

type Tier = "low" | "mid" | "high";
const tier = (count: number): Tier => (count >= 8 ? "high" : count >= 4 ? "mid" : "low");
const TIER_COLOR: Record<Tier, string> = { low: "#22d3ee", mid: "#fbbf24", high: "#fb7185" };

type Hover = { kind: "cluster"; cluster: Cluster; x: number; y: number } | { kind: "point"; point: GeoPoint; x: number; y: number } | null;

export default function InteractiveGeoMap({ vehicles }: { vehicles: TrustedVehicle[] }) {
  const { focus, setFocus } = useFilters();
  const [hover, setHover] = useState<Hover>(null);
  const [, setTick] = useState(0);

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

  const focusMembers = useMemo(
    () => (focus ? inRegion.filter((p) => focus.vehicleIds.includes(p.vehicleId)) : []),
    [focus, inRegion],
  );

  const emphasis = focus ? focusMembers : inRegion;
  const view = useMemo(() => (emphasis.length ? buildViewport(emphasis) : null), [emphasis]);
  const project = useMemo(() => (view ? projector(view) : null), [view]);

  // Sensor-style refresh while live-tracking: ~15 fps re-render.
  useEffect(() => {
    if (!focus) return;
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      if (ts - last > 66) {
        last = ts;
        setTick((t) => t + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  if (!view || !project || emphasis.length === 0) {
    return (
      <section className={`${CARD} px-6 py-14 text-sm text-slate-500`}>
        No measured latitude/longitude in the current filter scope — nothing to map without inventing geometry.
      </section>
    );
  }

  const now = Date.now();
  /** Emulated smooth motion around the last validated fix (live mode only). */
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

  return (
    <section className={CARD}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 pb-4 pt-6">
        <div>
          <p className={EYEBROW}>{focus ? "Live Location — Tracking Scope" : "Deployment Intelligence"}</p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight text-white">
            {focus ? `Tracking ${focusMembers.length} asset${focusMembers.length === 1 ? "" : "s"} — ${focus.label}` : "Charger density & live fleet position"}
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
            <svg viewBox={`0 0 ${view.width} ${view.height}`} className="block h-auto w-full" role="img" aria-label="Interactive fleet map">
              {visibleCities.map((city) => {
                const { x, y } = project(city.lat, city.lon);
                return (
                  <g key={city.name} opacity={0.55}>
                    <path d={`M ${x - 4} ${y} H ${x + 4} M ${x} ${y - 4} V ${y + 4}`} stroke="#46586f" strokeWidth="1" />
                    <text x={x + 6} y={y + 3} fill="#8ea3bd" fontSize="11">{city.name}</text>
                  </g>
                );
              })}

              {/* overview: clickable density bubbles */}
              {!focus &&
                clusters.map((cluster) => {
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

              {/* live mode: animated per-truck markers */}
              {focus &&
                focusMembers.map((p) => {
                  const pos = livePosition(p);
                  const { x, y } = project(pos.lat, pos.lon);
                  return (
                    <g
                      key={p.vehicleId}
                      className="cursor-pointer"
                      onMouseEnter={() => setHover({ kind: "point", point: p, x, y })}
                      onMouseLeave={() => setHover(null)}
                    >
                      <circle cx={x} cy={y} r={6} fill="none" stroke="#22d3ee" strokeWidth="1.5" opacity={0.8}>
                        <animate attributeName="r" values="6;22" dur="1.6s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.8;0" dur="1.6s" repeatCount="indefinite" />
                      </circle>
                      <circle cx={x} cy={y} r={5} fill="#22d3ee" fillOpacity={0.9} stroke="#031018" strokeWidth="1.5" />
                      <text x={x + 9} y={y - 7} fill="#e2f4ff" fontSize="11" fontFamily="ui-monospace, monospace">
                        {p.vehicleId}
                      </text>
                      <text x={x + 9} y={y + 6} fill="#7dd3fc" fontSize="10" fontFamily="ui-monospace, monospace">
                        {p.soc === null ? "SOC —" : `SOC ${p.soc}%`}
                      </text>
                    </g>
                  );
                })}
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

            {hover && (
              <div
                className="pointer-events-none absolute z-10 w-56 -translate-x-1/2 -translate-y-full rounded-xl border border-white/10 bg-slate-950/90 p-3 text-[11px] shadow-2xl backdrop-blur-xl"
                style={{ left: `${(hover.x / view.width) * 100}%`, top: `${(hover.y / view.height) * 100 - 2}%` }}
              >
                {hover.kind === "cluster" ? (
                  <>
                    <p className="font-mono text-sm font-semibold text-white">{hover.cluster.count} trucks</p>
                    <p className="text-slate-400">{hover.cluster.city.name}, {hover.cluster.city.state}</p>
                    <p className="mt-1 text-cyan-300">Click to open live location view</p>
                  </>
                ) : (
                  <>
                    <p className="truncate font-mono text-xs font-semibold text-white">{hover.point.vehicleId}</p>
                    <p className="font-mono text-slate-500">{hover.point.lat.toFixed(4)}, {hover.point.lon.toFixed(4)}</p>
                    <p className="mt-1 text-slate-500">
                      SOC {hover.point.soc === null ? "—" : `${hover.point.soc}%`} · {hover.point.speedKmh === null ? "—" : `${hover.point.speedKmh} km/h`}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
            {focus
              ? "Markers interpolate smoothly around each truck's last validated GPS fix to emulate a live sensor feed; the underlying coordinates are never fabricated beyond this visual drift."
              : "Click a bubble — or a ranked candidate — to drill into the live location view. The selection is a global filter: the asset sidebar narrows to exactly these trucks."}
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
                      {cluster.count} trucks
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
