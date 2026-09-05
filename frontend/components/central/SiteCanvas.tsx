"use client";

/**
 * Interactive isometric site canvas — the Central Dashboard's centrepiece.
 *
 * WHAT IT DRAWS
 *   * the plot, with an entry lane and an exit lane
 *   * 1 swap station: 4 battery bays + 1 gantry crane
 *   * 2 dual-gun chargers (4 guns)
 *   * 1 backup diesel generator + the grid feeder pylon
 *   * live energy flow along the bus: animated dashes whose speed and colour
 *     follow the modelled power, glowing green into any bay drawing current
 *   * a truck that drives in, docks, has its pack exchanged by the crane and
 *     drives out, whenever a swap transaction is active
 *
 * HOW IT IS BUILT
 *   True 2:1 isometric projection, hand-composed in screen space.  Every solid
 *   is a cuboid from `isoBox()` (one top face + two side faces), so the scene
 *   is a few hundred SVG nodes — no WebGL, no 3D library, no model download,
 *   and it prints, scales and themes like the rest of the UI.
 *
 *   Depth is painter's-algorithm: groups are emitted back-to-front, which for
 *   this projection is simply increasing screen y of each base centre.
 *
 *   Motion is a 1 Hz `tick` fed into the pure `simulateSite()` reducer.  The
 *   first render (server and client) is always tick 0, so hydration matches;
 *   `prefers-reduced-motion` and the pause control both freeze the tick.
 *
 * DRILL-DOWN
 *   Every asset group is a keyboard-reachable `role="link"` that routes to its
 *   telemetry page (`router.push`), because an HTML <a> cannot legally wrap
 *   SVG geometry.  Hovering prefetches the destination route.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ModelBadge, Pill } from "@/components/ui/Pill";
import type { SwapStation } from "@/lib/fleet";
import { ROAD_DOCK_T, SITE_ASSETS, simulateSite, type InboundSeed, type PackSeed } from "@/lib/site-model";

/* ------------------------------------------------------------ projection */

type Pt = [number, number];

/** Isometric basis: +x runs down-right, +y runs down-left (2:1). */
const EX: Pt = [1, 0.5];
const EY: Pt = [-1, 0.5];

const add = (p: Pt, q: Pt): Pt => [p[0] + q[0], p[1] + q[1]];
const scale = (p: Pt, k: number): Pt => [p[0] * k, p[1] * k];
const lift = (p: Pt, h: number): Pt => [p[0], p[1] - h];
const poly = (pts: Pt[]) => pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

/** The four base corners of a rhombus of half-extents (w, d) centred on c. */
function baseCorners(c: Pt, w: number, d: number): { front: Pt; right: Pt; back: Pt; left: Pt } {
  const wx = scale(EX, w);
  const dy = scale(EY, d);
  return {
    front: add(add(c, wx), dy),
    right: add(add(c, wx), scale(dy, -1)),
    back: add(add(c, scale(wx, -1)), scale(dy, -1)),
    left: add(add(c, scale(wx, -1)), dy),
  };
}

interface IsoBox {
  top: string;
  left: string;
  right: string;
  /** Screen point at the centre of the top face — label + flow anchor. */
  crown: Pt;
}

function isoBox(c: Pt, w: number, d: number, h: number): IsoBox {
  const b = baseCorners(c, w, d);
  const t = {
    front: lift(b.front, h),
    right: lift(b.right, h),
    back: lift(b.back, h),
    left: lift(b.left, h),
  };
  return {
    top: poly([t.front, t.right, t.back, t.left]),
    left: poly([b.left, b.front, t.front, t.left]),
    right: poly([b.front, b.right, t.right, t.front]),
    crown: lift(c, h),
  };
}

const tile = (c: Pt, w: number, d: number) => {
  const b = baseCorners(c, w, d);
  return poly([b.front, b.right, b.back, b.left]);
};

/* ------------------------------------------------------------- geometry */

const VIEW = { w: 1200, h: 680 };
const GROUND: Pt = [600, 380];

/** Entry lane -> apron -> exit lane.  `ROAD_DOCK_T` of this length is the bay
 *  apron, which is what keeps the model and the drawing in agreement. */
const ROAD: Pt[] = [
  [-80, 170],
  [140, 280],
  [340, 380],
  [520, 512],
  [700, 600],
  [900, 500],
  [1120, 390],
  [1280, 310],
];

/** Sample a polyline at t in [0, 1] by arc length. */
function samplePath(points: Pt[], t: number): { at: Pt; heading: Pt } {
  const segs: { a: Pt; b: Pt; len: number }[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len });
    total += len;
  }
  let target = Math.min(Math.max(t, 0), 1) * total;
  for (const s of segs) {
    if (target <= s.len) {
      const k = s.len === 0 ? 0 : target / s.len;
      return {
        at: [s.a[0] + (s.b[0] - s.a[0]) * k, s.a[1] + (s.b[1] - s.a[1]) * k],
        heading: [(s.b[0] - s.a[0]) / s.len, (s.b[1] - s.a[1]) / s.len],
      };
    }
    target -= s.len;
  }
  const last = segs[segs.length - 1];
  return { at: last.b, heading: [(last.b[0] - last.a[0]) / last.len, (last.b[1] - last.a[1]) / last.len] };
}

/** Anchors, all in screen space, ordered back-to-front where it matters. */
const ANCHOR = {
  station: [655, 292] as Pt,
  bays: [
    [430, 300],
    [500, 335],
    [570, 370],
    [640, 405],
  ] as Pt[],
  craneRail: { from: [408, 288] as Pt, to: [662, 415] as Pt, height: 132 },
  chargers: [
    [258, 430],
    [358, 480],
  ] as Pt[],
  dg: [860, 320] as Pt,
  pylon: [1090, 232] as Pt,
  bus: [770, 372] as Pt,
};

/* ------------------------------------------------------------ sub-shapes */

function Solid({
  box,
  top,
  left,
  right,
  opacity = 1,
}: {
  box: IsoBox;
  top: string;
  left: string;
  right: string;
  opacity?: number;
}) {
  return (
    <g opacity={opacity}>
      <polygon points={box.left} fill={left} />
      <polygon points={box.right} fill={right} />
      <polygon points={box.top} fill={top} />
    </g>
  );
}

/** Flow line: dashes animate only while `active`; colour follows the load. */
function Flow({ points, active, color, width = 2.5 }: { points: Pt[]; active: boolean; color: string; width?: number }) {
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
  return (
    <g>
      <path d={d} fill="none" stroke="var(--line-strong)" strokeWidth={width + 2} strokeLinecap="round" strokeOpacity={0.35} />
      <path
        d={d}
        fill="none"
        stroke={active ? color : "var(--ink-3)"}
        strokeWidth={width}
        strokeLinecap="round"
        strokeOpacity={active ? 0.95 : 0.3}
        className={active ? "energy-flow" : "energy-flow-slow"}
      />
    </g>
  );
}

/* ------------------------------------------------------------------ main */

export default function SiteCanvas({
  packs,
  inbound,
  station,
}: {
  packs: PackSeed[];
  inbound: InboundSeed[];
  station: SwapStation | null;
}) {
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // 1 Hz sim clock. Never runs on the server, so tick 0 is the shared frame.
  useEffect(() => {
    if (paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [paused]);

  const site = useMemo(() => simulateSite(tick, packs, inbound, station), [tick, packs, inbound, station]);

  const go = (href: string) => router.push(href);

  /**
   * Facility assets that no longer have a destination (chargers, DG, grid)
   * must NOT advertise themselves as clickable. `staticProps` gives them the
   * same hover highlight and accessible label without `role="link"`, a
   * pointer cursor or a router push — a control that looks clickable and does
   * nothing is the single most common trust bug in an operations UI.
   */
  const staticProps = (id: string, label: string) => ({
    "aria-label": label,
    className: "outline-none",
    onMouseEnter: () => setHoverId(id),
    onMouseLeave: () => setHoverId(null),
  });

  const linkProps = (id: string, href: string, label: string) => ({
    role: "link" as const,
    tabIndex: 0,
    "aria-label": label,
    className: "cursor-pointer outline-none",
    onMouseEnter: () => {
      setHoverId(id);
      router.prefetch(href);
    },
    onMouseLeave: () => setHoverId(null),
    onFocus: () => setHoverId(id),
    onBlur: () => setHoverId(null),
    onClick: () => go(href),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go(href);
      }
    },
  });

  const truckPose = samplePath(ROAD, site.dock.roadT);
  const apron = samplePath(ROAD, ROAD_DOCK_T).at;
  const truckVisible = site.dock.phase !== "clear";

  const ground = tile(GROUND, 340, 230);
  const stationBox = isoBox(ANCHOR.station, 150, 92, 104);
  const dgBox = isoBox(ANCHOR.dg, 62, 46, 52);

  /**
   * Bay roof tint.
   *
   * A charging bay is GREEN. Energy flowing into a pack is the most positive
   * state on this canvas and must read as such at a glance — the same
   * "good/charging" hue the status chips and map markers use, so one colour
   * means one thing across the whole product. `full` is that green at rest;
   * a vacant bay is inert grey.
   */
  const bayGlow = (i: number) => {
    const bay = site.bays[i];
    if (!bay) return "var(--ink-3)";
    if (bay.status === "vacant") return "var(--ink-3)";
    return "var(--ok)";
  };

  return (
    // `canvas-dark` re-declares the design tokens locally, so every child —
    // the SVG, the overlay pills, the Pause button — resolves `--surface`,
    // `--ink` and the status hues to their dark-ground values without any of
    // them knowing they are on a dark surface.
    <div className="canvas-dark relative overflow-hidden rounded-lg">
      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        className="block h-auto w-full select-none"
        role="img"
        aria-label="Interactive isometric model of the battery swap facility"
      >
        <defs>
          <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--surface-2)" />
            <stop offset="100%" stopColor="var(--surface-3)" />
          </linearGradient>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* ---------------------------------------------------- ground */}
        <polygon points={ground} fill="url(#plate)" stroke="var(--line-strong)" strokeWidth={1.5} />
        {/* apron markings */}
        <polygon points={tile([535, 352], 130, 26)} fill="var(--line)" opacity={0.5} />

        {/* ------------------------------------------------------- road */}
        <path
          d={ROAD.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ")}
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth={30}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.55}
        />
        <path
          d={ROAD.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ")}
          fill="none"
          stroke="var(--surface)"
          strokeWidth={2}
          strokeDasharray="10 12"
          opacity={0.8}
        />
        <text x={72} y={196} className="fill-[var(--ink-3)] text-[12px]" style={{ fontSize: 11 }}>
          Entry
        </text>
        <text x={1148} y={336} textAnchor="end" className="fill-[var(--ink-3)]" style={{ fontSize: 11 }}>
          Exit
        </text>

        {/* --------------------------------------------- energy flow bus */}
        <Flow
          points={[ANCHOR.pylon, [980, 300], ANCHOR.bus]}
          active
          color="var(--info)"
          width={3}
        />
        <Flow
          points={[[ANCHOR.dg[0], ANCHOR.dg[1] - 20], [820, 350], ANCHOR.bus]}
          active={site.dg.running}
          color="var(--warn)"
        />
        <Flow points={[ANCHOR.bus, [700, 330], [stationBox.crown[0], stationBox.crown[1] + 40]]} active color="var(--accent)" width={3} />
        {site.bays.map((bay, i) => (
          <Flow
            key={`flow-${bay.id}`}
            points={[[ANCHOR.station[0] - 40, ANCHOR.station[1] + 18], [ANCHOR.bays[i][0] + 26, ANCHOR.bays[i][1] - 6]]}
            active={bay.kw > 0}
            color={bay.status === "full" ? "var(--ok)" : "var(--accent)"}
            width={2}
          />
        ))}
        {site.chargers.map((charger, i) => (
          <Flow
            key={`flow-${charger.id}`}
            points={[ANCHOR.bus, [520, 430], [ANCHOR.chargers[i][0] + 30, ANCHOR.chargers[i][1] - 10]]}
            active={charger.totalKw > 0}
            color="var(--ok)"
            width={2}
          />
        ))}

        {/* -------------------------------------------------- grid pylon */}
        <g {...staticProps("grid", "Grid feeder — 250 kW utility supply")}>
          <path
            d={`M ${ANCHOR.pylon[0] - 18} ${ANCHOR.pylon[1] + 46} L ${ANCHOR.pylon[0] - 6} ${ANCHOR.pylon[1] - 40} L ${ANCHOR.pylon[0] + 6} ${ANCHOR.pylon[1] - 40} L ${ANCHOR.pylon[0] + 18} ${ANCHOR.pylon[1] + 46}`}
            fill="none"
            stroke="var(--ink-3)"
            strokeWidth={3}
          />
          <path
            d={`M ${ANCHOR.pylon[0] - 26} ${ANCHOR.pylon[1] - 30} H ${ANCHOR.pylon[0] + 26} M ${ANCHOR.pylon[0] - 20} ${ANCHOR.pylon[1] - 12} H ${ANCHOR.pylon[0] + 20}`}
            stroke="var(--ink-3)"
            strokeWidth={3}
            strokeLinecap="round"
          />
          <text x={ANCHOR.pylon[0]} y={ANCHOR.pylon[1] - 52} textAnchor="middle" style={{ fontSize: 11, fontWeight: 600 }} className="fill-[var(--ink-2)]">
            Grid {site.grid.importKw} kW
          </text>
        </g>

        {/* ------------------------------------------------------- station */}
        <g {...linkProps("swap-station", "/digital-twin/battery-tracking", "Swap station — open the pack register")}>
          <Solid
            box={stationBox}
            top="var(--surface)"
            left="var(--surface-3)"
            right="var(--plate)"
            opacity={hoverId === "swap-station" ? 0.94 : 1}
          />
          <polygon
            points={stationBox.top}
            fill="none"
            stroke={hoverId === "swap-station" ? "var(--accent)" : "var(--line-strong)"}
            strokeWidth={hoverId === "swap-station" ? 2.5 : 1.2}
          />
          <text
            x={stationBox.crown[0]}
            y={stationBox.crown[1] - 6}
            textAnchor="middle"
            style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4 }}
            className="fill-[var(--ink)]"
          >
            Swap station
          </text>
          <text x={stationBox.crown[0]} y={stationBox.crown[1] + 10} textAnchor="middle" style={{ fontSize: 10 }} className="fill-[var(--ink-3)]">
            {station?.name ?? "Unassigned hub"} · {site.totalDrawKw} kW draw
          </text>
        </g>

        {/* --------------------------------------------------- crane rail */}
        <g>
          <line
            x1={ANCHOR.craneRail.from[0]}
            y1={ANCHOR.craneRail.from[1] - ANCHOR.craneRail.height}
            x2={ANCHOR.craneRail.to[0]}
            y2={ANCHOR.craneRail.to[1] - ANCHOR.craneRail.height}
            stroke="var(--line-strong)"
            strokeWidth={6}
            strokeLinecap="round"
          />
          {[ANCHOR.craneRail.from, ANCHOR.craneRail.to].map((p, i) => (
            <line
              key={`leg-${i}`}
              x1={p[0]}
              y1={p[1]}
              x2={p[0]}
              y2={p[1] - ANCHOR.craneRail.height}
              stroke="var(--line-strong)"
              strokeWidth={4}
            />
          ))}
          {(() => {
            const t = Math.min(Math.max(site.dock.craneT, 0), 1);
            const cx = ANCHOR.craneRail.from[0] + (ANCHOR.craneRail.to[0] - ANCHOR.craneRail.from[0]) * t;
            const cy = ANCHOR.craneRail.from[1] + (ANCHOR.craneRail.to[1] - ANCHOR.craneRail.from[1]) * t - ANCHOR.craneRail.height;
            const drop = site.dock.hoistT * 96;
            const carrying = site.dock.phase === "swapping" && site.dock.hoistT > 0.4;
            return (
              <g>
                <rect x={cx - 16} y={cy - 8} width={32} height={14} rx={3} fill="var(--ink-2)" />
                <line x1={cx} y1={cy + 6} x2={cx} y2={cy + 6 + drop} stroke="var(--ink-3)" strokeWidth={2} />
                {drop > 4 &&
                  (() => {
                    // The pack on the hook: a real cuboid so it reads as a
                    // battery being lifted, not a floating rectangle.
                    const pack = isoBox([cx, cy + 12 + drop], 17, 13, 15);
                    return (
                      <g>
                        <polygon points={pack.left} fill="var(--surface-3)" />
                        <polygon points={pack.right} fill="var(--plate)" />
                        <polygon points={pack.top} fill={carrying ? "var(--accent)" : "var(--line-strong)"} />
                      </g>
                    );
                  })()}
              </g>
            );
          })()}
          <text
            x={(ANCHOR.craneRail.from[0] + ANCHOR.craneRail.to[0]) / 2}
            y={ANCHOR.craneRail.from[1] - ANCHOR.craneRail.height - 14}
            textAnchor="middle"
            style={{ fontSize: 10, fontWeight: 600 }}
            className="fill-[var(--ink-3)]"
          >
            Gantry crane
          </text>
        </g>

        {/* -------------------------------------------------------- bays */}
        {site.bays.map((bay, i) => {
          const c = ANCHOR.bays[i];
          const box = isoBox(c, 30, 24, bay.status === "vacant" ? 6 : 40);
          const glow = bayGlow(i);
          const hovered = hoverId === bay.id;
          return (
            <g
              key={bay.id}
              {...(bay.vehicleId
                ? linkProps(
                    bay.id,
                    `/digital-twin/battery-tracking?battery_id=${encodeURIComponent(bay.vehicleId)}`,
                    `${bay.id} — ${bay.status}, ${bay.batteryLabel ?? "pack"} — open in Battery Tracking`,
                  )
                : staticProps(bay.id, `${bay.id} — vacant`))}
            >
              <polygon points={tile(c, 34, 28)} fill="var(--plate)" stroke="var(--line-strong)" strokeWidth={1} />
              {bay.status !== "vacant" && (
                <>
                  {/* A pack roof is a NEUTRAL plane tinted by its charge state,
                      never a saturated slab: the status colour has to read as
                      information, and a full-strength fill turns the canvas
                      into decoration. Strength tracks charge, so a bay at 90%
                      is visibly hotter than one at 20% without going neon. */}
                  <Solid box={box} top="var(--surface-2)" left="var(--surface-3)" right="var(--plate)" opacity={hovered ? 0.92 : 1} />
                  <polygon
                    points={box.top}
                    fill={glow}
                    opacity={0.14 + ((bay.soc ?? 0) / 100) * 0.3}
                    stroke={glow}
                    strokeWidth={hovered ? 1.6 : 1}
                  />
                  {bay.kw > 0 && (
                    <polygon points={box.top} fill={glow} filter="url(#glow)" className="pulse-emissive" />
                  )}
                  <text x={box.crown[0]} y={box.crown[1] + 2} textAnchor="middle" style={{ fontSize: 11, fontWeight: 700 }} className="fill-[var(--ink)]">
                    {bay.soc}%
                  </text>
                </>
              )}
              <text x={c[0]} y={c[1] + 26} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600 }} className="fill-[var(--ink-3)]">
                Bay {bay.index}
              </text>
              {hovered && (
                <text x={c[0]} y={c[1] - 58} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600 }} className="fill-[var(--accent)]">
                  {bay.batteryLabel ?? "vacant"} {bay.kw > 0 ? `· ${bay.kw} kW` : ""}
                </text>
              )}
            </g>
          );
        })}

        {/* ---------------------------------------------------- chargers */}
        {site.chargers.map((charger, i) => {
          const c = ANCHOR.chargers[i];
          const box = isoBox(c, 26, 20, 62);
          const hovered = hoverId === charger.id;
          const live = charger.totalKw > 0;
          return (
            <g key={charger.id} {...staticProps(charger.id, `${charger.label} — facility asset`)}>
              <polygon points={tile(c, 40, 32)} fill="var(--plate)" stroke="var(--line-strong)" strokeWidth={1} />
              <Solid box={box} top="var(--surface-2)" left="var(--surface-3)" right="var(--plate)" opacity={hovered ? 0.92 : 1} />
              {live && (
                <>
                  <polygon points={box.top} fill="var(--ok)" opacity={0.18} stroke="var(--ok)" strokeWidth={1} />
                  <polygon points={box.top} fill="var(--ok)" filter="url(#glow)" className="pulse-emissive" />
                </>
              )}
              {/* two guns */}
              {charger.guns.map((gun, gi) => {
                // Guns hang off the kerb side of the unit, clear of the roof —
                // they were previously drawn over the top face and the kW
                // labels collided with the geometry.
                const gx = box.crown[0] + (gi === 0 ? -30 : 30);
                const gy = box.crown[1] + 30 + gi * 16;
                const tone = gun.status === "delivering" ? "var(--ok)" : gun.status === "handshake" ? "var(--warn)" : "var(--ink-3)";
                return (
                  <g key={gun.id}>
                    <circle cx={gx} cy={gy} r={4} fill={tone} className={gun.status === "delivering" ? "pulse-soft" : ""} />
                    <text x={gx} y={gy - 9} textAnchor="middle" style={{ fontSize: 9, fontWeight: 700 }} className="fill-[var(--ink-2)]">
                      {gun.kw > 0 ? `${gun.kw}kW` : "—"}
                    </text>
                  </g>
                );
              })}
              <text x={c[0]} y={c[1] + 28} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600 }} className="fill-[var(--ink-3)]">
                {charger.label.replace("Dual-gun ", "")}
              </text>
            </g>
          );
        })}

        {/* ---------------------------------------------------------- DG */}
        <g {...staticProps("dg", "Backup diesel generator — facility asset")}>
          <polygon points={tile(ANCHOR.dg, 76, 58)} fill="var(--plate)" stroke="var(--line-strong)" strokeWidth={1} />
          <Solid
            box={dgBox}
            top="var(--surface-2)"
            left="var(--surface-3)"
            right="var(--plate)"
            opacity={hoverId === "dg" ? 0.92 : 1}
          />
          {site.dg.running && (
            <>
              <polygon points={dgBox.top} fill="var(--warn)" opacity={0.18} stroke="var(--warn)" strokeWidth={1} />
              <polygon points={dgBox.top} fill="var(--warn)" filter="url(#glow)" className="pulse-emissive" />
            </>
          )}
          <text x={ANCHOR.dg[0]} y={ANCHOR.dg[1] + 44} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600 }} className="fill-[var(--ink-3)]">
            DG {site.dg.running ? `${site.dg.loadKw} kW` : "Standby"}
          </text>
        </g>

        {/* ------------------------------------------------------- truck */}
        {truckVisible && (
          <g
            {...linkProps(
              "truck",
              site.dock.truck ? `/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(site.dock.truck.vehicleId)}` : "/digital-twin/truck-telemetry",
              "Docking carrier — open truck telemetry",
            )}
          >
            {(() => {
              const [x, y] = truckPose.at;
              const trailer = isoBox([x, y], 42, 20, 34);
              const cab = isoBox([x + 44 * truckPose.heading[0] * 0.9, y + 44 * truckPose.heading[1] * 0.9], 16, 18, 30);
              const docked = site.dock.phase === "swapping" || site.dock.phase === "docking" || site.dock.phase === "release";
              return (
                <g>
                  <ellipse cx={x} cy={y + 8} rx={54} ry={16} fill="var(--ink)" opacity={0.08} />
                  <Solid box={trailer} top={docked ? "var(--accent)" : "var(--info)"} left="var(--surface-3)" right="var(--plate)" />
                  <Solid box={cab} top="var(--ink-2)" left="var(--surface-3)" right="var(--plate)" />
                  {docked && (
                    <>
                      <polygon points={trailer.top} fill="var(--accent)" filter="url(#glow)" className="pulse-emissive" />
                      <path
                        d={`M ${apron[0] - 46} ${apron[1] - 2} l 92 0`}
                        stroke="var(--accent)"
                        strokeWidth={2}
                        strokeDasharray="5 5"
                        className="energy-flow"
                      />
                    </>
                  )}
                  <text x={x} y={trailer.crown[1] - 10} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700 }} className="fill-[var(--ink)]">
                    {site.dock.truck?.carrierLabel ?? "Carrier"}
                  </text>
                  {site.dock.truck?.etaMinutes !== null && site.dock.phase === "approach" && (
                    <text x={x} y={trailer.crown[1] + 4} textAnchor="middle" style={{ fontSize: 9 }} className="fill-[var(--ink-3)]">
                      ETA {site.dock.truck?.etaMinutes} min · {site.dock.truck?.distanceKm} km
                    </text>
                  )}
                </g>
              );
            })()}
          </g>
        )}
      </svg>

      {/* ----------------------------------------------------- overlays */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
          {/* The card header that used to carry this was removed with the
              explanatory copy. The badge stays: bay charge progression, gun
              power, crane motion and DG state are MODELLED by lib/site-model.ts
              (the vehicle feed publishes no facility channels), and a surface
              that mixes modelled and measured data has to say so. It is a
              4-word pill with the detail in its tooltip, not a paragraph. */}
          <ModelBadge />
          <Pill tone={site.dock.phase === "clear" ? "neutral" : "accent"} dot pulse={site.dock.phase !== "clear"}>
            {site.dock.caption}
          </Pill>
        </div>

        <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="cursor-pointer rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-ink-2 shadow-[var(--shadow)] transition hover:text-ink"
          >
            {paused ? "▶ Resume" : "❚❚ Pause"}
          </button>
        </div>

        <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface/90 px-2.5 py-1.5 backdrop-blur-sm">
          {[
            ["var(--ok)", "charging / delivering"],
            ["var(--warn)", "DG running"],
            ["var(--ink-3)", "vacant / idle"],
          ].map(([color, label]) => (
            <span key={label} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
              <span className="h-2 w-2 rounded-full" style={{ background: color }} />
              {label}
            </span>
          ))}
          <span className="text-[11px] text-ink-3">· click any asset to drill down</span>
        </div>
      </div>
    </div>
  );
}

export { SITE_ASSETS };
