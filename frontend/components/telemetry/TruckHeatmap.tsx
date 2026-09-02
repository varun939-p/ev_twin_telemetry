"use client";

/**
 * TruckHeatmap -- charger-density view built from the validated `latitude` /
 * `longitude` parameters only.
 *
 * Presentation-only refactor: the projection, clustering, candidate ranking and
 * the data-quality honesty (no invented geometry, no hallucinated TN/KA, outliers
 * surfaced) are unchanged.  The surface is a self-contained SVG so it adds no
 * runtime dependency and renders identically offline -- now styled to sit inside
 * the same deep, hairline-minimal executive shell as the dashboard.
 */

import { useMemo, useState } from "react";

import {
  INDIA_BBOX,
  REFERENCE_CITIES,
  buildClusters,
  geoPoints,
  haversineKm,
  type Cluster,
  type GeoPoint,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";

export interface TruckHeatmapProps {
  vehicles: TrustedVehicle[];
  cellDeg?: number;
  candidateThreshold?: number;
  onSelectVehicle?: (vehicleId: string) => void;
  className?: string;
}

/* ------------------------------------------------------------------ style */

const CARD = "rounded-2xl border border-white/[0.06] bg-slate-900/40 backdrop-blur-md";
const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500";
const HAIRLINE = "h-px bg-white/[0.06]";

/* ------------------------------------------------------------- projection */

interface Viewport {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
  width: number;
  height: number;
}

const CANVAS_WIDTH = 1000;

function buildViewport(points: GeoPoint[]): Viewport {
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  const lonSpan = Math.max(Math.max(...lons) - Math.min(...lons), 0.5);
  const latSpan = Math.max(Math.max(...lats) - Math.min(...lats), 0.5);
  const padLon = lonSpan * 0.08;
  const padLat = latSpan * 0.1;

  const lonMin = Math.min(...lons) - padLon;
  const lonMax = Math.max(...lons) + padLon;
  const latMin = Math.min(...lats) - padLat;
  const latMax = Math.max(...lats) + padLat;
  const midLat = (latMin + latMax) / 2;

  const height = (CANVAS_WIDTH * (latMax - latMin)) / ((lonMax - lonMin) * Math.cos((midLat * Math.PI) / 180));
  return { lonMin, lonMax, latMin, latMax, width: CANVAS_WIDTH, height: Math.round(height) };
}

function projector(view: Viewport) {
  return (lat: number, lon: number) => ({
    x: ((lon - view.lonMin) / (view.lonMax - view.lonMin)) * view.width,
    y: ((view.latMax - lat) / (view.latMax - view.latMin)) * view.height,
  });
}

function gridStep(span: number): number {
  const steps = [1, 2, 5, 10, 20];
  return steps.find((s) => span / s <= 8) ?? 20;
}

type Tier = "low" | "mid" | "high";
function tier(count: number): Tier {
  if (count >= 8) return "high";
  if (count >= 4) return "mid";
  return "low";
}
const TIER_COLOR: Record<Tier, string> = { low: "#22d3ee", mid: "#fbbf24", high: "#fb7185" };
const TIER_OPACITY: Record<Tier, number> = { low: 0.42, mid: 0.5, high: 0.58 };

/* --------------------------------------------------------------- component */

type Hover =
  | { kind: "cluster"; cluster: Cluster; x: number; y: number }
  | { kind: "point"; point: GeoPoint; x: number; y: number }
  | null;

export default function TruckHeatmap({
  vehicles,
  cellDeg = 0.25,
  candidateThreshold = 2,
  onSelectVehicle,
  className = "",
}: TruckHeatmapProps) {
  const [hover, setHover] = useState<Hover>(null);
  const [showSingletons, setShowSingletons] = useState(true);
  const [showCities, setShowCities] = useState(true);
  const [showHeat, setShowHeat] = useState(true);

  const { points, unlocatable } = useMemo(() => geoPoints(vehicles), [vehicles]);

  const { inRegion, outliers } = useMemo(() => {
    const inside: GeoPoint[] = [];
    const outside: GeoPoint[] = [];
    for (const p of points) {
      const insideBox =
        p.lat >= INDIA_BBOX.latMin && p.lat <= INDIA_BBOX.latMax && p.lon >= INDIA_BBOX.lonMin && p.lon <= INDIA_BBOX.lonMax;
      (insideBox ? inside : outside).push(p);
    }
    return { inRegion: inside, outliers: outside };
  }, [points]);

  const clusters = useMemo(() => buildClusters(inRegion, cellDeg), [inRegion, cellDeg]);
  const candidates = useMemo(() => clusters.filter((c) => c.count >= candidateThreshold), [clusters, candidateThreshold]);
  const singletons = useMemo(() => clusters.filter((c) => c.count === 1), [clusters]);

  const view = useMemo(() => (inRegion.length ? buildViewport(inRegion) : null), [inRegion]);
  const project = useMemo(() => (view ? projector(view) : null), [view]);

  const southernmost = useMemo(() => (inRegion.length ? Math.min(...inRegion.map((p) => p.lat)) : null), [inRegion]);
  const northernmost = useMemo(() => (inRegion.length ? Math.max(...inRegion.map((p) => p.lat)) : null), [inRegion]);
  const top = candidates[0];

  if (!view || !project || inRegion.length === 0) {
    return (
      <section className={`${CARD} px-6 py-14 text-sm text-slate-500 ${className}`}>
        No validated frame in this scope carries a measured latitude/longitude. {unlocatable.length} asset(s) are
        unlocatable and are listed by the pipeline-health panel instead of being guessed at.
      </section>
    );
  }

  const lonStep = gridStep(view.lonMax - view.lonMin);
  const latStep = gridStep(view.latMax - view.latMin);
  const lonLines: number[] = [];
  for (let lon = Math.ceil(view.lonMin / lonStep) * lonStep; lon <= view.lonMax; lon += lonStep) lonLines.push(lon);
  const latLines: number[] = [];
  for (let lat = Math.ceil(view.latMin / latStep) * latStep; lat <= view.latMax; lat += latStep) latLines.push(lat);

  const maxCount = clusters[0]?.count ?? 1;
  const bubbleRadius = (count: number) => 10 + Math.sqrt(count / maxCount) * 34;
  const heatRadius = (count: number) => 34 + Math.sqrt(count / maxCount) * 108;

  const visibleCities = REFERENCE_CITIES.filter(
    (c) => c.lat >= view.latMin && c.lat <= view.latMax && c.lon >= view.lonMin && c.lon <= view.lonMax,
  );

  const hoveredCluster = hover?.kind === "cluster" ? hover.cluster : null;
  const toggles: { label: string; value: boolean; set: (fn: (v: boolean) => boolean) => void }[] = [
    { label: "Heat", value: showHeat, set: setShowHeat },
    { label: "Single", value: showSingletons, set: setShowSingletons },
    { label: "Cities", value: showCities, set: setShowCities },
  ];

  return (
    <section className={`${CARD} ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-4 px-6 pb-4 pt-6">
        <div>
          <p className={EYEBROW}>Expansion Intelligence</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-white">Charger Density — Where the Fleet Actually Runs</h2>
          <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-slate-600">
            {inRegion.length} GPS-bearing assets across {clusters.length} cells of ~{Math.round(cellDeg * 111)} km. Dense cells are corridors
            with no swap coverage today — charging happens elsewhere, which makes them the ranked targets for the next installation.
          </p>
        </div>

        {/* segmented layer control */}
        <div className="flex overflow-hidden rounded-full border border-white/[0.08]">
          {toggles.map((toggle) => (
            <button
              key={toggle.label}
              type="button"
              onClick={() => toggle.set((v: boolean) => !v)}
              className={`px-4 py-1.5 text-[11px] font-medium transition ${
                toggle.value ? "bg-cyan-400/15 text-cyan-200" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              {toggle.label}
            </button>
          ))}
        </div>
      </header>

      <div className={HAIRLINE} />

      <div className="grid grid-cols-1 gap-6 p-6 xl:grid-cols-3">
        {/* ------------------------------------------------------- map surface */}
        <div className="xl:col-span-2">
          <div className="relative overflow-hidden rounded-2xl bg-[#03060d] ring-1 ring-white/[0.05]">
            <svg viewBox={`0 0 ${view.width} ${view.height}`} className="block h-auto w-full" role="img" aria-label="Truck density map">
              <defs>
                {(Object.keys(TIER_COLOR) as Tier[]).map((t) => (
                  <radialGradient key={t} id={`heat-${t}`}>
                    <stop offset="0%" stopColor={TIER_COLOR[t]} stopOpacity={TIER_OPACITY[t]} />
                    <stop offset="55%" stopColor={TIER_COLOR[t]} stopOpacity={TIER_OPACITY[t] * 0.35} />
                    <stop offset="100%" stopColor={TIER_COLOR[t]} stopOpacity="0" />
                  </radialGradient>
                ))}
              </defs>

              <g stroke="#0c1626" strokeWidth="1">
                {lonLines.map((lon) => {
                  const { x } = project(view.latMin, lon);
                  return <line key={`lon-${lon}`} x1={x} y1={0} x2={x} y2={view.height} />;
                })}
                {latLines.map((lat) => {
                  const { y } = project(lat, view.lonMin);
                  return <line key={`lat-${lat}`} x1={0} y1={y} x2={view.width} y2={y} />;
                })}
              </g>
              <g fill="#2b3b52" fontSize="11" fontFamily="ui-monospace, monospace">
                {lonLines.map((lon) => {
                  const { x } = project(view.latMin, lon);
                  return (
                    <text key={`lonl-${lon}`} x={x + 3} y={view.height - 6}>
                      {lon}°E
                    </text>
                  );
                })}
                {latLines.map((lat) => {
                  const { y } = project(lat, view.lonMin);
                  return (
                    <text key={`latl-${lat}`} x={4} y={y - 4}>
                      {lat}°N
                    </text>
                  );
                })}
              </g>

              {showHeat && (
                <g style={{ mixBlendMode: "screen" }}>
                  {candidates.map((cluster) => {
                    const { x, y } = project(cluster.lat, cluster.lon);
                    return <circle key={`heat-${cluster.id}`} cx={x} cy={y} r={heatRadius(cluster.count)} fill={`url(#heat-${tier(cluster.count)})`} />;
                  })}
                </g>
              )}

              {showCities && (
                <g>
                  {visibleCities.map((city) => {
                    const { x, y } = project(city.lat, city.lon);
                    return (
                      <g key={city.name} opacity={0.7}>
                        <path d={`M ${x - 4} ${y} H ${x + 4} M ${x} ${y - 4} V ${y + 4}`} stroke="#46586f" strokeWidth="1" />
                        <text x={x + 6} y={y + 3} fill="#8ea3bd" fontSize="11">
                          {city.name}
                        </text>
                      </g>
                    );
                  })}
                </g>
              )}

              {showSingletons &&
                singletons.flatMap((cluster) =>
                  cluster.members.map((point) => {
                    const { x, y } = project(point.lat, point.lon);
                    return (
                      <circle
                        key={point.vehicleId}
                        cx={x}
                        cy={y}
                        r={4}
                        fill="#38bdf8"
                        fillOpacity={0.5}
                        stroke="#0ea5e9"
                        strokeWidth="1"
                        onMouseEnter={() => setHover({ kind: "point", point, x, y })}
                        onMouseLeave={() => setHover(null)}
                        className="cursor-pointer"
                      />
                    );
                  }),
                )}

              {candidates.map((cluster) => {
                const { x, y } = project(cluster.lat, cluster.lon);
                const active = hoveredCluster?.id === cluster.id;
                const color = TIER_COLOR[tier(cluster.count)];
                return (
                  <g
                    key={cluster.id}
                    onMouseEnter={() => setHover({ kind: "cluster", cluster, x, y })}
                    onMouseLeave={() => setHover(null)}
                    className="cursor-pointer"
                  >
                    <circle cx={x} cy={y} r={bubbleRadius(cluster.count)} fill={color} fillOpacity={active ? 0.3 : 0.12} stroke={color} strokeWidth={active ? 2.5 : 1.5} />
                    <text x={x} y={y + 4} textAnchor="middle" fill="#f8fafc" fontSize="13" fontWeight="600" fontFamily="ui-monospace, monospace">
                      {cluster.count}
                    </text>
                    <text x={x} y={y + bubbleRadius(cluster.count) + 14} textAnchor="middle" fill="#94a3b8" fontSize="11">
                      {cluster.city.name}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* tooltip */}
            {hover && (
              <div
                className="pointer-events-none absolute z-10 w-56 -translate-x-1/2 -translate-y-full rounded-xl border border-white/10 bg-slate-950/90 p-3 text-[11px] shadow-2xl backdrop-blur-xl"
                style={{ left: `${(hover.x / view.width) * 100}%`, top: `${(hover.y / view.height) * 100 - 2}%` }}
              >
                {hover.kind === "cluster" ? (
                  <>
                    <p className="font-mono text-sm font-semibold text-white">
                      {hover.cluster.count} truck{hover.cluster.count === 1 ? "" : "s"}
                    </p>
                    <p className="text-slate-400">
                      {hover.cluster.city.name}, {hover.cluster.city.state} · ~{hover.cluster.city.distanceKm} km
                    </p>
                    <p className="mt-1 text-slate-500">
                      avg SOC {hover.cluster.avgSoc === null ? "—" : `${hover.cluster.avgSoc}%`} · {((hover.cluster.count / inRegion.length) * 100).toFixed(0)}% of fleet
                    </p>
                    <p className="mt-1 truncate font-mono text-[10px] text-slate-600">
                      {hover.cluster.members
                        .slice(0, 3)
                        .map((m) => m.vehicleId)
                        .join(", ")}
                      {hover.cluster.members.length > 3 ? ` +${hover.cluster.members.length - 3}` : ""}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="truncate font-mono text-xs font-semibold text-white">{hover.point.vehicleId}</p>
                    <p className="font-mono text-slate-500">
                      {hover.point.lat.toFixed(4)}, {hover.point.lon.toFixed(4)}
                    </p>
                    <p className="mt-1 text-slate-500">
                      SOC {hover.point.soc === null ? "—" : `${hover.point.soc}%`} · {hover.point.speedKmh === null ? "—" : `${hover.point.speedKmh} km/h`}
                    </p>
                    {onSelectVehicle && <p className="mt-1 text-cyan-300">Click to open in the twin</p>}
                  </>
                )}
              </div>
            )}

            {/* legend */}
            <div className="absolute bottom-3 left-3 rounded-xl border border-white/[0.06] bg-slate-950/80 px-3 py-2 text-[10px] text-slate-500 backdrop-blur-md">
              <p className="mb-1.5 uppercase tracking-[0.16em] text-slate-600">Trucks / cell</p>
              <div className="flex items-center gap-4">
                {(Object.keys(TIER_COLOR) as Tier[]).map((t) => (
                  <span key={t} className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: TIER_COLOR[t] }} />
                    {t === "high" ? "8+" : t === "mid" ? "4–7" : "2–3"}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
            Mapped span {southernmost?.toFixed(2)}°N–{northernmost?.toFixed(2)}°N. No frame sits south of {southernmost?.toFixed(1)}°N, so there is no
            Tamil Nadu or Karnataka presence to rank — the candidate list is derived from the coordinates actually present.
          </p>
        </div>

        {/* ------------------------------------------------- ranked targets */}
        <div className="space-y-5">
          <div>
            <h3 className={EYEBROW}>Deployment Candidates</h3>
            <ol className="mt-4 space-y-3">
              {candidates.slice(0, 6).map((cluster, index) => {
                const share = (cluster.count / inRegion.length) * 100;
                const rankTier = cluster.count >= 10 ? "Primary" : cluster.count >= 5 ? "Secondary" : "Watch";
                const rankTone =
                  rankTier === "Primary" ? "text-rose-300 bg-rose-400/10" : rankTier === "Secondary" ? "text-amber-300 bg-amber-400/10" : "text-cyan-300 bg-cyan-400/10";
                return (
                  <li
                    key={cluster.id}
                    onMouseEnter={() => {
                      const { x, y } = project(cluster.lat, cluster.lon);
                      setHover({ kind: "cluster", cluster, x, y });
                    }}
                    onMouseLeave={() => setHover(null)}
                    className="rounded-xl p-3 transition hover:bg-white/[0.03]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono text-sm text-white">
                        <span className="mr-2 text-slate-600">{String(index + 1).padStart(2, "0")}</span>
                        {cluster.count} trucks
                      </p>
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide ${rankTone}`}>{rankTier}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {cluster.city.name}, {cluster.city.state} · ~{cluster.city.distanceKm} km
                    </p>
                    <div className="mt-2 h-px w-full overflow-hidden rounded-full bg-white/[0.06]">
                      <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-rose-400" style={{ width: `${share}%` }} />
                    </div>
                    <p className="mt-1 text-[10px] text-slate-600">
                      {share.toFixed(0)}% of mapped fleet · avg SOC {cluster.avgSoc === null ? "—" : `${cluster.avgSoc}%`}
                    </p>
                  </li>
                );
              })}
            </ol>
            {top && (
              <p className="mt-4 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.05] p-3.5 text-[11px] leading-relaxed text-cyan-100/90">
                Strongest signal: <span className="font-mono font-semibold">{top.count}</span> trucks in one ~{Math.round(cellDeg * 111)} km cell near{" "}
                {top.city.name}, {top.city.state} — {((top.count / inRegion.length) * 100).toFixed(0)}% of the mapped fleet. First candidate for the next charger.
              </p>
            )}
          </div>

          <div className={HAIRLINE} />

          <div>
            <h3 className={EYEBROW}>Data Quality</h3>
            <ul className="mt-3 space-y-2 text-[11px] text-slate-600">
              <li>
                <span className="font-mono text-slate-400">{points.length}</span> measured positions ·{" "}
                <span className="font-mono text-slate-400">{unlocatable.length}</span> unlocatable
              </li>
              <li>
                <span className="font-mono text-slate-400">{inRegion.length}</span> in region ·{" "}
                <span className="font-mono text-slate-400">{outliers.length}</span> outlier(s) excluded
              </li>
              {outliers.map((o) => (
                <li key={o.vehicleId} className="rounded-lg border border-amber-400/15 bg-amber-400/[0.04] px-2.5 py-1.5 font-mono text-[10px] text-amber-200/80">
                  {o.vehicleId} @ {o.lat.toFixed(2)}, {o.lon.toFixed(2)} — outside India bbox; treated as a device fault
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
