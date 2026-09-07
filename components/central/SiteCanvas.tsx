"use client";

/**
 * Interactive Isometric Digital Twin Facility Canvas — Central Dashboard.
 *
 * HYBRID EXECUTIVE REALISM EDITION:
 *   * Preserves the exact 2:1 isometric foundation, road geometry, swap station,
 *     grid feeder, and energy flow bus from the baseline screenshot.
 *   * Upgrades the key industrial assets to photorealistic, physically accurate 3D models:
 *     - Real Carrier Truck: Arbitrary-heading 3D oriented chassis & cab that physically
 *       and mathematically follows the road curve with exact 3D world projection.
 *       On entry, the cab points straight down-right along the road. At the dock, it stops
 *       parallel to the bays. Through the curve, it steers smoothly with continuous tangent.
 *       On the exit lane, the head is strictly straight up-right along the exit road.
 *       Features aerodynamic wrap-around windshield, projector LED headlights, roof clearance
 *       lights, side mirrors, low-deck diamond-plate bed, 4 vertical 3D upright wheels with
 *       rubber tread & alloy rims, and a proudly seated high-voltage battery pack (never sunken).
 *     - Real Swap Station Backup Diesel Generator (DG): MANDATORILY GROUNDED on a reinforced
 *       cast-concrete foundation slab resting directly on the facility floor, heavy structural
 *       steel base skid with forklift pockets, containerized acoustic canopy with stamped
 *       soundproof intake louvers, digital control panel with E-stop button, rooftop residential
 *       exhaust silencer muffler with counterweighted rain cap, radiator fan, and amber beacon.
 *     - Real Industrial Gantry Crane: Elevated double-girder overhead runway tracks with
 *       A-frame lattice supports, motorized traveling bridge, hoist crab trolley with cable drum,
 *       4 vertical braided wire ropes, heavy spreader beam with corner twist-locks,
 *       and an active multi-stage battery swap sequence.
 *     - Real EV Fast Chargers A & B: Heavy concrete plinths, dual-tone titanium columns,
 *       angled digital screens with live kW readouts, side holsters, and 3D hanging cables.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { ModelBadge, Pill } from "@/components/ui/Pill";
import type { SwapStation } from "@/lib/fleet";
import { ROAD_DOCK_T, SITE_ASSETS, simulateSite, type InboundSeed, type PackSeed } from "@/lib/site-model";

/* ------------------------------------------------------------ projection */

type Pt = [number, number];
type Pt3 = [number, number, number];

/** Isometric basis: +x runs down-right, +y runs down-left (2:1). */
const EX: Pt = [1, 0.5];
const EY: Pt = [-1, 0.5];

const add = (p: Pt, q: Pt): Pt => [p[0] + q[0], p[1] + q[1]];
const scale = (p: Pt, k: number): Pt => [p[0] * k, p[1] * k];
const lift = (p: Pt, h: number): Pt => [p[0], p[1] - h];
const poly = (pts: Pt[]) => pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

/** Projects 3D world coordinate (X, Y, Z) to 2D isometric screen coordinate [u, v]. */
function project3D(X: number, Y: number, Z: number): Pt {
  return [X - Y, 0.5 * (X + Y) - Z];
}

/** Unprojects 2D screen coordinate [sx, sy] at ground level (Z=0) to 3D world coordinate [X, Y, 0]. */
function unproject2D(sx: number, sy: number): Pt3 {
  return [sy + 0.5 * sx, sy - 0.5 * sx, 0];
}

/** Computes signed area of 2D screen polygon for back-face culling. */
function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

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
  crown: Pt;
  base: { front: Pt; right: Pt; back: Pt; left: Pt };
  topPts: { front: Pt; right: Pt; back: Pt; left: Pt };
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
    base: b,
    topPts: t,
  };
}

const tile = (c: Pt, w: number, d: number) => {
  const b = baseCorners(c, w, d);
  return poly([b.front, b.right, b.back, b.left]);
};

/* ----------------------------- true 3D oriented box (world coordinate projection) */

interface SolidFace {
  name: string;
  pts: Pt[];
  ptsStr: string;
  color: string;
  midY: number;
}

interface World3DBox {
  top: string;
  topPts: Pt[];
  basePts: Pt[];
  faces: SolidFace[];
  crown: Pt;
}

/**
 * Constructs a physically true 3D solid box in world coordinates rotated by heading angle alpha,
 * and projects all vertices into 2:1 isometric space. Culls back faces and depth-sorts all walls.
 */
function makeWorld3DBox(
  worldCenter: Pt3,
  length: number,
  width: number,
  height: number,
  alpha: number, // 0 = world +X (down-right), pi/2 = world -Y (up-right)
  colors: { top: string; front: string; back: string; left: string; right: string },
): World3DBox {
  const [cx, cy, cz] = worldCenter;
  const cosA = Math.cos(alpha);
  const sinA = Math.sin(alpha);
  // Heading vector along length
  const hx = cosA;
  const hy = -sinA;
  // Lateral vector along width (vehicle's left)
  const wx = sinA;
  const wy = cosA;

  const hl = length / 2;
  const hw = width / 2;

  // 4 bottom vertices in world [FL, FR, BR, BL]
  const vb: Pt3[] = [
    [cx + hl * hx + hw * wx, cy + hl * hy + hw * wy, cz],
    [cx + hl * hx - hw * wx, cy + hl * hy - hw * wy, cz],
    [cx - hl * hx - hw * wx, cy - hl * hy - hw * wy, cz],
    [cx - hl * hx + hw * wx, cy - hl * hy + hw * wy, cz],
  ];
  // 4 top vertices in world
  const vt: Pt3[] = vb.map(([x, y, z]) => [x, y, z + height]);

  // Project to 2D screen space
  const pb = vb.map(([x, y, z]) => project3D(x, y, z));
  const pt = vt.map(([x, y, z]) => project3D(x, y, z));

  const rawFaces: { name: string; pts: Pt[]; color: string }[] = [
    { name: "top", pts: [pt[0], pt[1], pt[2], pt[3]], color: colors.top },
    { name: "front", pts: [pb[0], pb[1], pt[1], pt[0]], color: colors.front },
    { name: "right", pts: [pb[1], pb[2], pt[2], pt[1]], color: colors.right },
    { name: "back", pts: [pb[2], pb[3], pt[3], pt[2]], color: colors.back },
    { name: "left", pts: [pb[3], pb[0], pt[0], pt[3]], color: colors.left },
  ];

  const visibleFaces: SolidFace[] = [];
  for (const f of rawFaces) {
    if (f.name === "top" || signedArea(f.pts) < 0) {
      const midY = f.pts.reduce((sum, p) => sum + p[1], 0) / f.pts.length;
      visibleFaces.push({
        name: f.name,
        pts: f.pts,
        ptsStr: poly(f.pts),
        color: f.color,
        midY,
      });
    }
  }

  visibleFaces.sort((a, b) => a.midY - b.midY);

  return {
    top: poly([pt[0], pt[1], pt[2], pt[3]]),
    topPts: pt,
    basePts: pb,
    faces: visibleFaces,
    crown: project3D(cx, cy, cz + height),
  };
}

/* ------------------------------------------------------------- geometry */

const VIEW = { w: 1200, h: 680 };
const GROUND: Pt = [600, 380];

/**
 * Road knots with exact 2:1 isometric slopes:
 *   - Entry: [-80, 170] -> [140, 280] -> [340, 380] -> [540, 480] (strictly slope +0.5, heading down-right)
 *   - Curve: [540, 480] -> [680, 545] -> [780, 550] -> [880, 500] (smooth 90-degree transition)
 *   - Exit:  [880, 500] -> [1040, 420] -> [1180, 350] -> [1280, 300] (strictly slope -0.5, heading up-right)
 */
const ROAD_KNOTS: Pt[] = [
  [-80, 170],
  [140, 280],
  [340, 380],
  [540, 480],
  [680, 545],
  [780, 550],
  [880, 500],
  [1040, 420],
  [1180, 350],
  [1280, 300],
];

/** Pre-computed dense spline points with cumulative arc lengths for smooth steering and interpolation. */
interface RoadSample {
  at: Pt;
  heading: Pt;
  alpha: number; // World heading in radians
}

const ROAD_SPLINE: { points: Pt[]; lengths: number[]; totalLen: number } = (() => {
  const pts: Pt[] = [];
  // Build a finely sampled road path with smooth corners
  for (let i = 0; i < ROAD_KNOTS.length - 1; i++) {
    const a = ROAD_KNOTS[i];
    const b = ROAD_KNOTS[i + 1];
    const steps = i >= 3 && i <= 5 ? 24 : 12; // Extra dense through the corner turn
    for (let s = 0; s < steps; s++) {
      const k = s / steps;
      pts.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  pts.push(ROAD_KNOTS[ROAD_KNOTS.length - 1]);

  const lengths: number[] = [0];
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    lengths.push(lengths[lengths.length - 1] + d);
  }
  return { points: pts, lengths, totalLen: lengths[lengths.length - 1] };
})();

/** Samples the road path at progress t in [0, 1], returning screen position, tangent, and exact 3D world heading. */
function sampleRoad(prog: number): RoadSample {
  const { points, lengths, totalLen } = ROAD_SPLINE;
  const target = Math.min(Math.max(prog, 0), 1) * totalLen;

  for (let i = 0; i < lengths.length - 1; i++) {
    if (target <= lengths[i + 1]) {
      const segLen = lengths[i + 1] - lengths[i];
      const k = segLen === 0 ? 0 : (target - lengths[i]) / segLen;
      const at: Pt = [
        points[i][0] + (points[i + 1][0] - points[i][0]) * k,
        points[i][1] + (points[i + 1][1] - points[i][1]) * k,
      ];

      // Smooth tangent lookahead
      const iNext = Math.min(points.length - 1, i + 3);
      const iPrev = Math.max(0, i - 2);
      const dx = points[iNext][0] - points[iPrev][0];
      const dy = points[iNext][1] - points[iPrev][1];
      const len = Math.hypot(dx, dy) || 1;
      const heading: Pt = [dx / len, dy / len];

      // Closed-form exact world heading: alpha = atan2(1 - 2*slope, 1 + 2*slope)
      const slope = heading[0] !== 0 ? heading[1] / heading[0] : 0;
      const alpha = Math.atan2(1 - 2 * slope, 1 + 2 * slope);

      return { at, heading, alpha };
    }
  }

  const last = points[points.length - 1];
  return { at: last, heading: [0.8944, -0.4472], alpha: Math.PI / 2 };
}

/** Anchors in screen space, matching baseline layout. */
const ANCHOR = {
  station: [655, 292] as Pt,
  bays: [
    [430, 300],
    [500, 335],
    [570, 370],
    [640, 405],
  ] as Pt[],
  craneRail: { from: [404, 284] as Pt, to: [668, 418] as Pt, height: 148 },
  chargers: [
    [258, 430] as Pt,
    [358, 480] as Pt,
  ],
  // Mandatorily grounded DG anchor firmly touching ground
  dg: [860, 335] as Pt,
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

/** Flow line with animated energy pulses. */
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
  appearance = "enhanced",
}: {
  packs: PackSeed[];
  inbound: InboundSeed[];
  station: SwapStation | null;
  appearance?: "original" | "enhanced";
}) {
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const enhanced = appearance === "enhanced";

  // 1 Hz sim clock
  useEffect(() => {
    if (paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [paused]);

  const site = useMemo(() => simulateSite(tick, packs, inbound, station), [tick, packs, inbound, station]);
  const go = (href: string) => router.push(href);

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

  const truckPose = sampleRoad(site.dock.roadT);
  const apronPose = sampleRoad(ROAD_DOCK_T);
  const truckVisible = site.dock.phase !== "clear";

  const ground = tile(GROUND, 340, 230);
  const stationBox = isoBox(ANCHOR.station, 150, 92, 104);

  const bayGlow = (i: number) => {
    const bay = site.bays[i];
    if (!bay) return "var(--ink-3)";
    if (bay.status === "vacant") return "var(--ink-3)";
    return "var(--ok)";
  };

  return (
    <div
      className={
        enhanced
          ? "facility-stage relative isolate overflow-hidden rounded-lg bg-slate-950 shadow-2xl border border-slate-800/80"
          : "canvas-dark relative overflow-hidden rounded-lg bg-slate-950 shadow-2xl border border-slate-800/80"
      }
    >
      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto w-full select-none"
        role="group"
        aria-label="Interactive isometric model of the battery swap facility"
      >
        <title>Interactive battery swap facility model</title>
        <defs>
          <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1e293b" />
            <stop offset="100%" stopColor="#0f172a" />
          </linearGradient>
          <linearGradient id="cabPaintBody" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="50%" stopColor="#0284c7" />
            <stop offset="100%" stopColor="#0369a1" />
          </linearGradient>
          <linearGradient id="windshieldGlass" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#0f172a" stopOpacity="0.95" />
            <stop offset="50%" stopColor="#38bdf8" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#0284c7" stopOpacity="0.85" />
          </linearGradient>
          <linearGradient id="chargerTitanium" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#334155" />
            <stop offset="100%" stopColor="#0f172a" />
          </linearGradient>
          <linearGradient id="dgGensetCanopy" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#475569" />
            <stop offset="40%" stopColor="#334155" />
            <stop offset="100%" stopColor="#1e293b" />
          </linearGradient>
          <linearGradient id="concreteFoundation" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#475569" />
            <stop offset="100%" stopColor="#334155" />
          </linearGradient>
          <linearGradient id="rubberTireGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#27272a" />
            <stop offset="60%" stopColor="#18181b" />
            <stop offset="100%" stopColor="#09090b" />
          </linearGradient>
          <linearGradient id="alloyRimGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f8fafc" />
            <stop offset="50%" stopColor="#cbd5e1" />
            <stop offset="100%" stopColor="#64748b" />
          </linearGradient>
          <radialGradient id="beaconPulse" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.95" />
            <stop offset="50%" stopColor="#d97706" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#b45309" stopOpacity="0" />
          </radialGradient>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* ---------------------------------------------------- ground */}
        <polygon points={ground} fill="url(#plate)" stroke="var(--line-strong)" strokeWidth={1.5} />
        {/* Apron markings positioned right along the dock lane */}
        <polygon points={tile([535, 460], 110, 24)} fill="var(--line)" opacity={0.35} />

        {/* ------------------------------------------------------- road */}
        {/* Road Base Bed (Asphalt) */}
        <path
          d={ROAD_SPLINE.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")}
          fill="none"
          stroke="#0f172a"
          strokeWidth={34}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.9}
        />
        <path
          d={ROAD_SPLINE.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")}
          fill="none"
          stroke="#1e293b"
          strokeWidth={30}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.6}
        />
        {/* White Center Dashed Line */}
        <path
          d={ROAD_SPLINE.points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ")}
          fill="none"
          stroke="#f8fafc"
          strokeWidth={2}
          strokeDasharray="10 12"
          opacity={0.7}
        />
        <text x={72} y={196} className="fill-[var(--ink-3)] text-[12px] font-semibold" style={{ fontSize: 11 }}>
          Entry
        </text>
        <text x={1148} y={326} textAnchor="end" className="fill-[var(--ink-3)] text-[12px] font-semibold" style={{ fontSize: 11 }}>
          Exit
        </text>

        {/* --------------------------------------------- energy flow bus */}
        <Flow points={[ANCHOR.pylon, [980, 300], ANCHOR.bus]} active color="var(--info)" width={3} />
        <Flow points={[[ANCHOR.dg[0], ANCHOR.dg[1] - 20], [820, 350], ANCHOR.bus]} active={site.dg.running} color="var(--warn)" />
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
          {/* Ceramic insulators */}
          {[-20, 0, 20].map((off, idx) => (
            <rect key={`ins-${idx}`} x={ANCHOR.pylon[0] + off - 2} y={ANCHOR.pylon[1] - 18} width={4} height={10} fill="#94a3b8" rx={1} />
          ))}
          <text x={ANCHOR.pylon[0]} y={ANCHOR.pylon[1] - 52} textAnchor="middle" style={{ fontSize: 11, fontWeight: 600 }} className="fill-[var(--ink-2)]">
            Grid {site.grid.importKw} kW
          </text>
        </g>

        {/* ------------------------------------------------------- station */}
        <g {...linkProps("swap-station", "/digital-twin/swap-station/overview", "Swap station — open station operations")}>
          <Solid box={stationBox} top="var(--surface)" left="var(--surface-3)" right="var(--plate)" opacity={hoverId === "swap-station" ? 0.94 : 1} />
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
            {station?.name ?? "Pune"} · {site.totalDrawKw} kW draw
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
              {...linkProps(
                bay.id,
                bay.vehicleId
                  ? `/digital-twin/battery-tracking?battery_id=${encodeURIComponent(bay.vehicleId)}`
                  : "/digital-twin/battery-tracking",
                `${bay.id} — ${bay.status}${bay.batteryLabel ? `, ${bay.batteryLabel}` : ""} — open in Battery Tracking`,
              )}
            >
              <polygon points={tile(c, 34, 28)} fill="var(--plate)" stroke="var(--line-strong)" strokeWidth={1} />
              {bay.status !== "vacant" && (
                <>
                  <Solid box={box} top="var(--surface-2)" left="var(--surface-3)" right="var(--plate)" opacity={hovered ? 0.92 : 1} />
                  <polygon
                    points={box.top}
                    fill={glow}
                    opacity={0.14 + ((bay.soc ?? 0) / 100) * 0.3}
                    stroke={glow}
                    strokeWidth={hovered ? 1.6 : 1}
                  />
                  {bay.kw > 0 && <polygon points={box.top} fill={glow} filter="url(#glow)" className="pulse-emissive" />}
                  <text x={box.crown[0]} y={box.crown[1] + 2} textAnchor="middle" style={{ fontSize: 11, fontWeight: 700 }} className="fill-[var(--ink)]">
                    {bay.soc ?? 0}%
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

        {/* --------------------------------- REAL 3D EV FAST CHARGERS */}
        {site.chargers.map((charger, i) => {
          const c = ANCHOR.chargers[i];
          const hovered = hoverId === charger.id;
          const live = charger.totalKw > 0;

          const plinth = isoBox(c, 34, 26, 8);
          const colBase = isoBox(lift(c, 8), 28, 22, 14);
          const colMain = isoBox(lift(c, 22), 26, 20, 48);
          const colHead = isoBox(lift(c, 70), 24, 16, 14);

          return (
            <g
              key={charger.id}
              {...linkProps(charger.id, "/digital-twin/charging-station", `${charger.label} — open charging station`)}
            >
              <Solid box={plinth} top="#334155" left="#1e293b" right="#0f172a" />
              <Solid box={colBase} top="#1e293b" left="#0f172a" right="#0284c7" />
              <Solid box={colMain} top="url(#chargerTitanium)" left="#1e293b" right="#0f172a" opacity={hovered ? 0.92 : 1} />
              <Solid box={colHead} top="#0f172a" left="#1e293b" right="#0284c7" />

              <line x1={colMain.base.front[0]} y1={colMain.base.front[1]} x2={colMain.topPts.front[0]} y2={colMain.topPts.front[1]} stroke="#0284c7" strokeWidth={2.5} />

              <rect
                x={colHead.crown[0] - 18}
                y={colHead.crown[1] - 6}
                width={36}
                height={16}
                rx={2}
                fill="#090d16"
                stroke={live ? "#10b981" : "#475569"}
                strokeWidth={1}
              />
              <text
                x={colHead.crown[0]}
                y={colHead.crown[1] + 6}
                textAnchor="middle"
                style={{ fontSize: 9, fontWeight: 700, fontFamily: "monospace" }}
                className={live ? "fill-[#34d399]" : "fill-[#94a3b8]"}
              >
                {live ? `${charger.totalKw}kW` : "STANDBY"}
              </text>

              {charger.guns.map((gun, gi) => {
                const isLeft = gi === 0;
                const portX = colMain.topPts.front[0] + (isLeft ? -14 : 14);
                const portY = colMain.topPts.front[1] - 8;
                const holsterX = colMain.base.front[0] + (isLeft ? -22 : 22);
                const holsterY = colMain.base.front[1] - 14;
                const loopX = isLeft ? holsterX - 12 : holsterX + 12;
                const loopY = holsterY + 18;

                const tone = gun.status === "delivering" ? "var(--ok)" : gun.status === "handshake" ? "var(--warn)" : "var(--ink-3)";

                return (
                  <g key={gun.id}>
                    <path
                      d={`M ${portX} ${portY} C ${loopX} ${portY + 20}, ${loopX} ${loopY}, ${holsterX} ${holsterY}`}
                      fill="none"
                      stroke="#0f172a"
                      strokeWidth={4.5}
                      strokeLinecap="round"
                    />
                    <path
                      d={`M ${portX} ${portY} C ${loopX} ${portY + 20}, ${loopX} ${loopY}, ${holsterX} ${holsterY}`}
                      fill="none"
                      stroke="#475569"
                      strokeWidth={2}
                      strokeLinecap="round"
                    />
                    <rect x={holsterX - 3} y={holsterY - 4} width={6} height={8} rx={1} fill="#64748b" />
                    <circle cx={holsterX} cy={holsterY - 9} r={3.5} fill={tone} className={gun.status === "delivering" ? "pulse-soft" : ""} />
                  </g>
                );
              })}

              <text x={c[0]} y={c[1] + 28} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600 }} className="fill-[var(--ink-3)]">
                {charger.label.replace("Dual-gun ", "")}
              </text>
            </g>
          );
        })}

        {/* ---------------- AUTHENTIC GROUNDED SWAP STATION BACKUP GENERATOR (DG) */}
        {(() => {
          const dgHovered = hoverId === "dg";
          const dgBase = ANCHOR.dg;

          // 1. Reinforced Cast-Concrete Foundation Pad firmly resting directly on the ground slab
          const pad = isoBox(dgBase, 66, 46, 8);
          // 2. Heavy Structural Steel Perimeter Skid with sub-base fuel tank
          const skid = isoBox(lift(dgBase, 8), 62, 42, 10);
          // 3. Containerized Acoustic Enclosure Canopy
          const canopy = isoBox(lift(dgBase, 18), 56, 38, 46);

          return (
            <g {...linkProps("dg", "/digital-twin/dg/overview", "Backup diesel generator — open generator analysis")}>
              {/* Cast Concrete Foundation Pad firmly touching ground level */}
              <Solid box={pad} top="url(#concreteFoundation)" left="#1e293b" right="#0f172a" />
              <polygon points={pad.top} fill="none" stroke="#64748b" strokeWidth={1} />
              {/* Foundation Hold-down Anchor Bolt Plates */}
              {[pad.base.front, pad.base.left, pad.base.right].map((pt, bi) => (
                <circle key={`dg-bolt-${bi}`} cx={pt[0]} cy={pt[1] - 5} r={2.5} fill="#94a3b8" stroke="#475569" strokeWidth={0.8} />
              ))}

              {/* Structural Steel Base Skid with Forklift Pockets */}
              <Solid box={skid} top="#334155" left="#1e293b" right="#0f172a" />
              {/* Dual Forklift Pocket Channels */}
              <rect x={skid.base.front[0] - 22} y={skid.base.front[1] - 8} width={13} height={6} rx={1} fill="#090d16" stroke="#475569" strokeWidth={0.8} />
              <rect x={skid.base.front[0] + 9} y={skid.base.front[1] - 8} width={13} height={6} rx={1} fill="#090d16" stroke="#475569" strokeWidth={0.8} />

              {/* Sound-Attenuated Weatherproof Acoustic Enclosure */}
              <Solid
                box={canopy}
                top="url(#dgGensetCanopy)"
                left="#1e293b"
                right="#0f172a"
                opacity={dgHovered ? 0.94 : 1}
              />
              {site.dg.running && (
                <polygon points={canopy.top} fill="var(--warn)" opacity={0.24} stroke="var(--warn)" strokeWidth={1.5} filter="url(#glow)" />
              )}

              {/* Laser-Cut Intake Air Louvers with Sound Baffles */}
              {Array.from({ length: 6 }).map((_, li) => {
                const lx = canopy.crown[0] - 26 + li * 4.2;
                const ly = canopy.crown[1] + 16 + li * 2.1;
                return (
                  <line
                    key={`dg-louver-${li}`}
                    x1={lx - 16}
                    y1={ly}
                    x2={lx + 8}
                    y2={ly + 12}
                    stroke="#090d16"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                  />
                );
              })}

              {/* Flush Deep Sea Digital Controller Panel */}
              <rect x={canopy.base.front[0] - 16} y={canopy.crown[1] + 14} width={20} height={15} rx={1.5} fill="#090d16" stroke="#64748b" strokeWidth={1} />
              <rect x={canopy.base.front[0] - 14} y={canopy.crown[1] + 16} width={16} height={7} rx={1} fill="#0284c7" opacity={0.9} />
              {/* Emergency Stop Button with Yellow Safety Shroud */}
              <circle cx={canopy.base.front[0] - 6} cy={canopy.crown[1] + 25} r={2.8} fill="#ef4444" stroke="#eab308" strokeWidth={1} />

              {/* Circular Rooftop Radiator Cowling with Spinning Fan Blades */}
              <ellipse cx={canopy.crown[0] - 18} cy={canopy.crown[1] - 4} rx={14} ry={7} fill="#1e293b" stroke="#64748b" strokeWidth={1.5} />
              <g className={site.dg.running ? "animate-spin" : ""} style={{ transformOrigin: `${canopy.crown[0] - 18}px ${canopy.crown[1] - 4}px` }}>
                <line x1={canopy.crown[0] - 28} y1={canopy.crown[1] - 4} x2={canopy.crown[0] - 8} y2={canopy.crown[1] - 4} stroke="#cbd5e1" strokeWidth={1.8} />
                <line x1={canopy.crown[0] - 18} y1={canopy.crown[1] - 9} x2={canopy.crown[0] - 18} y2={canopy.crown[1] + 1} stroke="#cbd5e1" strokeWidth={1.8} />
              </g>

              {/* Heavy Residential Silencer Muffler & Flapper Rain Cap */}
              <g>
                <rect x={canopy.crown[0] + 6} y={canopy.crown[1] - 9} width={24} height={9} rx={4} fill="#475569" stroke="#64748b" strokeWidth={1} />
                <line x1={canopy.crown[0] + 22} y1={canopy.crown[1] - 9} x2={canopy.crown[0] + 22} y2={canopy.crown[1] - 20} stroke="#cbd5e1" strokeWidth={3.5} strokeLinecap="round" />
                <line x1={canopy.crown[0] + 17} y1={canopy.crown[1] - 21} x2={canopy.crown[0] + 27} y2={canopy.crown[1] - 23} stroke="#f8fafc" strokeWidth={2.2} strokeLinecap="round" />
              </g>

              {/* Rooftop Amber Warning Strobe Beacon */}
              <rect x={canopy.crown[0] + 34} y={canopy.crown[1] - 10} width={7} height={9} rx={2} fill="#f59e0b" stroke="#b45309" strokeWidth={1} />
              {site.dg.running && (
                <circle cx={canopy.crown[0] + 37} cy={canopy.crown[1] - 6} r={14} fill="url(#beaconPulse)" className="pulse-emissive" />
              )}

              {/* Armored Power Feeder Bus Connection */}
              <path
                d={`M ${canopy.base.left[0] + 12} ${canopy.base.left[1] - 8} Q ${ANCHOR.bus[0] + 30} ${ANCHOR.bus[1] - 10} ${ANCHOR.bus[0]} ${ANCHOR.bus[1]}`}
                fill="none"
                stroke="#0f172a"
                strokeWidth={5}
                strokeLinecap="round"
              />
              <path
                d={`M ${canopy.base.left[0] + 12} ${canopy.base.left[1] - 8} Q ${ANCHOR.bus[0] + 30} ${ANCHOR.bus[1] - 10} ${ANCHOR.bus[0]} ${ANCHOR.bus[1]}`}
                fill="none"
                stroke="#475569"
                strokeWidth={2.5}
                strokeLinecap="round"
              />

              <text x={dgBase[0]} y={dgBase[1] + 34} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600 }} className="fill-[var(--ink-3)]">
                Generator {site.dg.running ? `${site.dg.loadKw} kW` : "Standby"}
              </text>
            </g>
          );
        })()}

        {/* ------------------------- REAL 3D HIGH-FIDELITY ELECTRIC TRUCK (EV PROTOTYPE) */}
        {truckVisible && (() => {
          const currentTruck = site.dock.truck ?? inbound[0] ?? null;
          const targetVehicleId = currentTruck?.vehicleId ?? null;
          const truckHref = targetVehicleId
            ? `/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(targetVehicleId)}`
            : "/digital-twin/truck-telemetry";

          return (
            <g
              {...linkProps(
                "truck",
                truckHref,
                `Electric Carrier ${currentTruck?.carrierLabel ?? "EV"} — open live truck telemetry`,
              )}
            >
              {(() => {
                const [sx, sy] = truckPose.at;
                const alpha = truckPose.alpha;
                const [X0, Y0] = unproject2D(sx, sy);
                const cosA = Math.cos(alpha);
                const sinA = Math.sin(alpha);
                const hx = cosA;
                const hy = -sinA;
                const wx = sinA;
                const wy = cosA;

                const docked = site.dock.phase === "swapping" || site.dock.phase === "docking" || site.dock.phase === "release";

                // 1. Aerodynamic Underbody Chassis & High-Voltage Battery Side Skirt Fairings (Z=2)
                const chassis = makeWorld3DBox([X0, Y0, 2], 52, 18, 7, alpha, {
                  top: "#1e293b",
                  front: "#0f172a",
                  right: "#090d16",
                  back: "#0f172a",
                  left: "#1e293b",
                });

                // 2. Low-Deck Titanium Flatbed Trailer Deck with 5th Wheel Coupling (Z=8)
                const trailerCenter: Pt3 = [X0 - 12 * hx, Y0 - 12 * hy, 8];
                const trailer = makeWorld3DBox(trailerCenter, 32, 20, 6, alpha, {
                  top: docked ? "var(--accent)" : "#334155",
                  front: "#1e293b",
                  right: "#0f172a",
                  back: "#090d16",
                  left: "#334155",
                });

                // 3. Swappable High-Voltage Modular Battery Pack (Z=14)
                const packCenter: Pt3 = [X0 - 12 * hx, Y0 - 12 * hy, 14];
                const pack = makeWorld3DBox(packCenter, 22, 16, 13, alpha, {
                  top: docked ? "var(--ok)" : "url(#cabPaintBody)",
                  front: "#0284c7",
                  right: "#0369a1",
                  back: "#075985",
                  left: "#0284c7",
                });

                // 4. EV Aerodynamic Lower Cab Nose & Aero Fascia (Z=8, No Diesel Grille, Flush Aero Shield)
                const cabLowerCenter: Pt3 = [X0 + 16 * hx, Y0 + 16 * hy, 8];
                const cabLower = makeWorld3DBox(cabLowerCenter, 18, 20, 13, alpha, {
                  top: "#0284c7",
                  front: "#0369a1",
                  right: "#0f172a",
                  back: "#075985",
                  left: "#0284c7",
                });

                // 5. EV Aerodynamic Upper Cockpit & Panoramic Glass Canopy (Z=21, Raked Aerodynamic Taper)
                const cabUpperCenter: Pt3 = [X0 + 14 * hx, Y0 + 14 * hy, 21];
                const cabUpper = makeWorld3DBox(cabUpperCenter, 14, 18, 15, alpha, {
                  top: "url(#cabPaintBody)",
                  front: "#0284c7",
                  right: "#0f172a",
                  back: "#075985",
                  left: "#0284c7",
                });

                // 6. Four Turbine Aero-Disc Wheels with Synthetic Rubber Tires
                const wheelTrack = 12;
                const axleFront = 16;
                const axleRear = -14;

                const wheelOffsets = [
                  { name: "fl", dl: axleFront, dw: wheelTrack },
                  { name: "fr", dl: axleFront, dw: -wheelTrack },
                  { name: "rl", dl: axleRear, dw: wheelTrack },
                  { name: "rr", dl: axleRear, dw: -wheelTrack },
                ];

                const wheels = wheelOffsets.map((w) => {
                  const wxPos = X0 + w.dl * hx + w.dw * wx;
                  const wyPos = Y0 + w.dl * hy + w.dw * wy;
                  const [wSx, wSy] = project3D(wxPos, wyPos, 0);
                  const isForeground = wSy >= sy - 1;
                  return { name: w.name, sx: wSx, sy: wSy, isForeground };
                });

                const renderWheel = (w: { name: string; sx: number; sy: number }) => (
                  <g key={`wheel-${w.name}`}>
                    {/* Road Contact Patch Ground Shadow */}
                    <ellipse cx={w.sx} cy={w.sy + 1} rx={5.5} ry={2.6} fill="#020617" opacity={0.85} />
                    {/* Low-Rolling-Resistance Synthetic Rubber Tire */}
                    <rect x={w.sx - 3.5} y={w.sy - 12} width={7} height={13} rx={3} fill="url(#rubberTireGrad)" stroke="#09090b" strokeWidth={1} />
                    {/* Turbine Aero-Disc Rim (Aerodynamic Wheel Cover) */}
                    <rect x={w.sx - 2.5} y={w.sy - 10} width={5} height={9} rx={2} fill="url(#alloyRimGrad)" stroke="#475569" strokeWidth={0.8} />
                    {/* Directional Aero Vanes */}
                    <line x1={w.sx - 2} y1={w.sy - 8} x2={w.sx + 2} y2={w.sy - 4} stroke="#334155" strokeWidth={0.8} />
                    <line x1={w.sx - 2} y1={w.sy - 4} x2={w.sx + 2} y2={w.sy - 7} stroke="#334155" strokeWidth={0.8} />
                    {/* Center Hub Cap */}
                    <circle cx={w.sx} cy={w.sy - 5.5} r={1.2} fill="#0f172a" />
                  </g>
                );

                // Front Aero Nose & Lighting Coordinates
                const noseCenter = project3D(X0 + 25 * hx, Y0 + 25 * hy, 14);
                const drlLeft = project3D(X0 + 25 * hx + 8.5 * wx, Y0 + 25 * hy + 8.5 * wy, 16);
                const drlRight = project3D(X0 + 25 * hx - 8.5 * wx, Y0 + 25 * hy - 8.5 * wy, 16);
                const hlLeft = project3D(X0 + 25 * hx + 7 * wx, Y0 + 25 * hy + 7 * wy, 12);
                const hlRight = project3D(X0 + 25 * hx - 7 * wx, Y0 + 25 * hy - 7 * wy, 12);
                const splitterLeft = project3D(X0 + 25.5 * hx + 9.5 * wx, Y0 + 25.5 * hy + 9.5 * wy, 8.5);
                const splitterRight = project3D(X0 + 25.5 * hx - 9.5 * wx, Y0 + 25.5 * hy - 9.5 * wy, 8.5);

                // High-Voltage Cyan Runner along lower aero skirts
                const skirtLeftF = project3D(X0 + 20 * hx + 9.2 * wx, Y0 + 20 * hy + 9.2 * wy, 4.5);
                const skirtLeftR = project3D(X0 - 20 * hx + 9.2 * wx, Y0 - 20 * hy + 9.2 * wy, 4.5);
                const skirtRightF = project3D(X0 + 20 * hx - 9.2 * wx, Y0 + 20 * hy - 9.2 * wy, 4.5);
                const skirtRightR = project3D(X0 - 20 * hx - 9.2 * wx, Y0 - 20 * hy - 9.2 * wy, 4.5);

                // Fifth-Wheel Heavy Turntable Coupling
                const fifthWheel = project3D(X0 + 2 * hx, Y0 + 2 * hy, 14.2);

                // Digital Mirror-Cam Stalks
                const camLeftBase = project3D(X0 + 16 * hx + 9 * wx, Y0 + 16 * hy + 9 * wy, 28);
                const camLeftTip = project3D(X0 + 15 * hx + 13.5 * wx, Y0 + 15 * hy + 13.5 * wy, 28);
                const camRightBase = project3D(X0 + 16 * hx - 9 * wx, Y0 + 16 * hy - 9 * wy, 28);
                const camRightTip = project3D(X0 + 15 * hx - 13.5 * wx, Y0 + 15 * hy - 13.5 * wy, 28);

                // Panoramic Wraparound Windshield Points
                const wsFL = project3D(X0 + 21 * hx + 8 * wx, Y0 + 21 * hy + 8 * wy, 23);
                const wsFR = project3D(X0 + 21 * hx - 8 * wx, Y0 + 21 * hy - 8 * wy, 23);
                const wsTL = project3D(X0 + 16.5 * hx + 7 * wx, Y0 + 16.5 * hy + 7 * wy, 35);
                const wsTR = project3D(X0 + 16.5 * hx - 7 * wx, Y0 + 16.5 * hy - 7 * wy, 35);

                return (
                  <g className="transition-opacity duration-200 hover:opacity-95">
                    {/* Generous Interactive Click Hitbox covering the entire truck profile */}
                    <rect
                      x={sx - 70}
                      y={sy - 75}
                      width={140}
                      height={100}
                      fill="transparent"
                      pointerEvents="all"
                      className="cursor-pointer"
                    />

                    {/* Vehicle Ambient Occlusion Ground Contact Shadow */}
                    <ellipse cx={sx} cy={sy + 6} rx={58} ry={19} fill="#020617" opacity={0.75} />

                    {/* Background Wheels (Behind vehicle body) */}
                    {wheels.filter((w) => !w.isForeground).map(renderWheel)}

                    {/* Aerodynamic Underbody Chassis & Skirt Fairings */}
                    {chassis.faces.map((f, fi) => (
                      <polygon key={`chassis-${fi}`} points={f.ptsStr} fill={f.color} stroke="#090d16" strokeWidth={0.6} />
                    ))}

                    {/* High-Voltage Cyan LED Runners along Skirts */}
                    <line x1={skirtLeftF[0]} y1={skirtLeftF[1]} x2={skirtLeftR[0]} y2={skirtLeftR[1]} stroke="#38bdf8" strokeWidth={1.8} strokeLinecap="round" opacity={0.85} filter="url(#glow)" />
                    <line x1={skirtRightF[0]} y1={skirtRightF[1]} x2={skirtRightR[0]} y2={skirtRightR[1]} stroke="#38bdf8" strokeWidth={1.8} strokeLinecap="round" opacity={0.85} filter="url(#glow)" />

                    {/* Trailer Flatbed Deck */}
                    {trailer.faces.map((f, fi) => (
                      <polygon key={`trailer-${fi}`} points={f.ptsStr} fill={f.color} stroke="#1e293b" strokeWidth={0.6} />
                    ))}

                    {/* Fifth-Wheel Turntable Ring */}
                    <ellipse cx={fifthWheel[0]} cy={fifthWheel[1]} rx={5} ry={2.5} fill="#090d16" stroke="#64748b" strokeWidth={1} />

                    {/* Side Underrun Safety Crash Bars with Hazard Stripes */}
                    <line
                      x1={trailer.basePts[3][0]}
                      y1={trailer.basePts[3][1] - 2}
                      x2={trailer.basePts[0][0]}
                      y2={trailer.basePts[0][1] - 2}
                      stroke="#eab308"
                      strokeWidth={2}
                      strokeDasharray="5 4"
                    />

                    {/* Swappable High-Voltage Modular Battery Pack */}
                    {pack.faces.map((f, fi) => (
                      <polygon key={`pack-${fi}`} points={f.ptsStr} fill={f.color} stroke="#075985" strokeWidth={0.6} />
                    ))}
                    {docked && <polygon points={pack.top} fill="var(--ok)" filter="url(#glow)" opacity={0.75} />}

                    {/* Battery Pack Corner Lifting Twist-Lock Brackets */}
                    {pack.topPts.map((pt, ci) => (
                      <circle key={`lug-${ci}`} cx={pt[0]} cy={pt[1]} r={2} fill="#eab308" stroke="#713f12" strokeWidth={0.8} />
                    ))}

                    {/* Active Battery Glow Status Bar */}
                    <line
                      x1={pack.basePts[0][0]}
                      y1={pack.basePts[0][1] - 4}
                      x2={pack.basePts[1][0]}
                      y2={pack.basePts[1][1] - 4}
                      stroke={docked ? "#34d399" : "#38bdf8"}
                      strokeWidth={2.5}
                    />

                    {/* Rear LED Taillight Clusters */}
                    <circle cx={trailer.basePts[2][0]} cy={trailer.basePts[2][1] - 3} r={2.5} fill="#ef4444" filter="url(#glow)" />
                    <circle cx={trailer.basePts[3][0]} cy={trailer.basePts[3][1] - 3} r={2.5} fill="#ef4444" filter="url(#glow)" />

                    {/* EV Aerodynamic Lower Cab Nose (Flush Aero Shield) */}
                    {cabLower.faces.map((f, fi) => (
                      <polygon key={`cabLower-${fi}`} points={f.ptsStr} fill={f.color} stroke="#0369a1" strokeWidth={0.6} />
                    ))}

                    {/* Carbon-Fiber Lower Chin Splitter */}
                    <line x1={splitterLeft[0]} y1={splitterLeft[1]} x2={splitterRight[0]} y2={splitterRight[1]} stroke="#090d16" strokeWidth={3} strokeLinecap="round" />

                    {/* Full-Width Cyber Horizon LED Light Bar across Nose */}
                    <line x1={drlLeft[0]} y1={drlLeft[1]} x2={drlRight[0]} y2={drlRight[1]} stroke="#f8fafc" strokeWidth={2.4} strokeLinecap="round" filter="url(#glow)" />

                    {/* Dual Matrix Projector LED Headlights */}
                    <circle cx={hlLeft[0]} cy={hlLeft[1]} r={2.8} fill="#f8fafc" filter="url(#glow)" />
                    <circle cx={hlRight[0]} cy={hlRight[1]} r={2.8} fill="#f8fafc" filter="url(#glow)" />

                    {/* EV Aero Nose Badge Emblem */}
                    <circle cx={noseCenter[0]} cy={noseCenter[1]} r={1.5} fill="#38bdf8" filter="url(#glow)" />

                    {/* EV Aerodynamic Upper Cockpit & Canopy */}
                    {cabUpper.faces.map((f, fi) => (
                      <polygon key={`cabUpper-${fi}`} points={f.ptsStr} fill={f.color} stroke="#0369a1" strokeWidth={0.6} />
                    ))}

                    {/* Panoramic Wraparound Tinted Windshield Glass */}
                    <polygon
                      points={`${wsFL[0]},${wsFL[1]} ${wsFR[0]},${wsFR[1]} ${wsTL[0]},${wsTL[1]} ${wsTR[0]},${wsTR[1]}`}
                      fill="url(#windshieldGlass)"
                      stroke="#38bdf8"
                      strokeWidth={0.9}
                    />

                    {/* Digital Mirror-Cam Aero Stalks */}
                    <g>
                      <line x1={camLeftBase[0]} y1={camLeftBase[1]} x2={camLeftTip[0]} y2={camLeftTip[1]} stroke="#1e293b" strokeWidth={2.2} strokeLinecap="round" />
                      <circle cx={camLeftTip[0]} cy={camLeftTip[1]} r={1.4} fill="#38bdf8" stroke="#090d16" strokeWidth={0.6} />
                      <line x1={camRightBase[0]} y1={camRightBase[1]} x2={camRightTip[0]} y2={camRightTip[1]} stroke="#1e293b" strokeWidth={2.2} strokeLinecap="round" />
                      <circle cx={camRightTip[0]} cy={camRightTip[1]} r={1.4} fill="#38bdf8" stroke="#090d16" strokeWidth={0.6} />
                    </g>

                    {/* Rooftop Aerodynamic Amber Marker Lights */}
                    {[-5, 0, 5].map((mOff, mi) => (
                      <circle key={`marker-${mi}`} cx={cabUpper.crown[0] + mOff} cy={cabUpper.crown[1] - 1.5} r={1.2} fill="#f59e0b" />
                    ))}

                    {/* Foreground Wheels */}
                    {wheels.filter((w) => w.isForeground).map(renderWheel)}

                    {/* Docking Laser Guide & Umbilical */}
                    {docked && (
                      <path
                        d={`M ${apronPose.at[0] - 46} ${apronPose.at[1] - 2} l 92 0`}
                        stroke="var(--accent)"
                        strokeWidth={2}
                        strokeDasharray="5 5"
                        className="energy-flow"
                      />
                    )}

                    {/* Floating Holographic Telemetry Pill (Glassmorphic HUD) */}
                    <g transform={`translate(${cabUpper.crown[0]}, ${cabUpper.crown[1] - 38})`}>
                      <rect
                        x={-64}
                        y={-14}
                        width={128}
                        height={26}
                        rx={6}
                        fill="#020617"
                        fillOpacity={0.9}
                        stroke="#38bdf8"
                        strokeWidth={1}
                        strokeOpacity={hoverId === "truck" ? 1 : 0.6}
                        filter="url(#glow)"
                        className="transition-all"
                      />
                      {/* Live Carrier Label */}
                      <text x={-56} y={-1} textAnchor="start" style={{ fontSize: 9.5, fontWeight: 700 }} className="fill-[var(--ink)]">
                        ⚡ {currentTruck?.carrierLabel ?? "EV Semi 800V"}
                      </text>
                      {/* Live Data Sub-Label (SOC + Operational Status) */}
                      <text x={-56} y={9} textAnchor="start" style={{ fontSize: 8, fontWeight: 600 }} className="fill-[#38bdf8]">
                        {typeof currentTruck?.soc === "number" ? `${currentTruck.soc}% SOC` : "800V BEV"} · {currentTruck?.etaMinutes != null && site.dock.phase === "approach" ? `ETA ${currentTruck.etaMinutes}m` : (docked ? "DOCKING" : site.dock.phase.toUpperCase())}
                      </text>
                      {/* Interactive Telemetry Arrow */}
                      <text x={54} y={4} textAnchor="end" style={{ fontSize: 10, fontWeight: 700 }} className="fill-[#38bdf8]">
                        ↗
                      </text>
                    </g>
                  </g>
                );
              })()}
            </g>
          );
        })()}

        {/* ---------------------------- REAL INDUSTRIAL 3D GANTRY CRANE (OVER TRUCK) */}
        <g
          {...linkProps(
            "gantry-crane",
            "/digital-twin/swap-station/overview",
            "Gantry crane — open swap station operations",
          )}
        >
          {/* Heavy Lattice Support Portal Columns */}
          {[ANCHOR.craneRail.from, ANCHOR.craneRail.to].map((p, i) => {
            const h = ANCHOR.craneRail.height;
            return (
              <g key={`crane-support-${i}`}>
                {/* Ground anchor plate */}
                <polygon points={tile(p, 10, 10)} fill="#0f172a" stroke="#64748b" strokeWidth={1.5} />
                {/* Main vertical steel columns */}
                <line x1={p[0] - 3} y1={p[1]} x2={p[0] - 3} y2={p[1] - h} stroke="#475569" strokeWidth={5} strokeLinecap="round" />
                <line x1={p[0] + 3} y1={p[1]} x2={p[0] + 3} y2={p[1] - h} stroke="#334155" strokeWidth={4} strokeLinecap="round" />
                {/* Diagonal lattice truss braces */}
                {[0.25, 0.5, 0.75].map((pct, bi) => (
                  <line
                    key={`truss-${bi}`}
                    x1={p[0] - 3}
                    y1={p[1] - h * pct}
                    x2={p[0] + 3}
                    y2={p[1] - h * (pct + 0.12)}
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                  />
                ))}
              </g>
            );
          })}

          {/* Dual Runway Girders with End Bumpers */}
          <line
            x1={ANCHOR.craneRail.from[0]}
            y1={ANCHOR.craneRail.from[1] - ANCHOR.craneRail.height}
            x2={ANCHOR.craneRail.to[0]}
            y2={ANCHOR.craneRail.to[1] - ANCHOR.craneRail.height}
            stroke="#334155"
            strokeWidth={9}
            strokeLinecap="round"
          />
          <line
            x1={ANCHOR.craneRail.from[0]}
            y1={ANCHOR.craneRail.from[1] - ANCHOR.craneRail.height - 4}
            x2={ANCHOR.craneRail.to[0]}
            y2={ANCHOR.craneRail.to[1] - ANCHOR.craneRail.height - 4}
            stroke="#eab308"
            strokeWidth={3}
            strokeDasharray="14 6"
          />

          {/* Active 3D Bridge Crane, Hoist Crab & Spreader */}
          {(() => {
            const isSwapping = site.dock.phase === "swapping";
            const isDocking = site.dock.phase === "docking";
            const progress = site.dock.progress;

            let bridgeProgress = Math.min(Math.max(site.dock.craneT, 0), 1);
            let hoistDrop = site.dock.hoistT * 92;
            let carryingPack = false;

            if (isSwapping) {
              if (progress < 0.25) {
                bridgeProgress = 0.5;
                hoistDrop = (progress / 0.25) * 88;
                carryingPack = progress > 0.15;
              } else if (progress < 0.5) {
                const subP = (progress - 0.25) / 0.25;
                bridgeProgress = 0.5 + subP * 0.45;
                hoistDrop = 88 - subP * 40;
                carryingPack = true;
              } else if (progress < 0.75) {
                const subP = (progress - 0.5) / 0.25;
                bridgeProgress = 0.95 - subP * 0.45;
                hoistDrop = 48 + Math.sin(subP * Math.PI) * 36;
                carryingPack = true;
              } else {
                const subP = (progress - 0.75) / 0.25;
                bridgeProgress = 0.5;
                hoistDrop = (1 - subP) * 88;
                carryingPack = subP < 0.6;
              }
            } else if (isDocking) {
              bridgeProgress = 0.5;
              hoistDrop = progress * 24;
            }

            const cx = ANCHOR.craneRail.from[0] + (ANCHOR.craneRail.to[0] - ANCHOR.craneRail.from[0]) * bridgeProgress;
            const cy = ANCHOR.craneRail.from[1] + (ANCHOR.craneRail.to[1] - ANCHOR.craneRail.from[1]) * bridgeProgress - ANCHOR.craneRail.height;

            return (
              <g>
                {/* Motorized Double-Girder Bridge Carriage */}
                <rect x={cx - 24} y={cy - 12} width={48} height={18} rx={3} fill="#eab308" stroke="#ca8a04" strokeWidth={1.5} />
                <rect x={cx - 18} y={cy - 8} width={36} height={6} fill="#090d16" opacity={0.7} />
                <line x1={cx - 22} y1={cy + 4} x2={cx - 16} y2={cy - 10} stroke="#090d16" strokeWidth={2} />
                <line x1={cx + 16} y1={cy + 4} x2={cx + 22} y2={cy - 10} stroke="#090d16" strokeWidth={2} />

                {/* Hoist Crab Trolley & Winch Drum */}
                <rect x={cx - 12} y={cy - 18} width={24} height={10} rx={2} fill="#334155" stroke="#64748b" strokeWidth={1} />
                <circle cx={cx} cy={cy - 21} r={3} fill={isSwapping ? "#f59e0b" : "#64748b"} className={isSwapping ? "pulse-emissive" : ""} />

                {/* 4 Braided Steel Wire Hoist Ropes */}
                <line x1={cx - 8} y1={cy + 6} x2={cx - 8} y2={cy + 6 + hoistDrop} stroke="#cbd5e1" strokeWidth={1.5} />
                <line x1={cx - 4} y1={cy + 6} x2={cx - 4} y2={cy + 6 + hoistDrop} stroke="#94a3b8" strokeWidth={1} />
                <line x1={cx + 4} y1={cy + 6} x2={cx + 4} y2={cy + 6 + hoistDrop} stroke="#94a3b8" strokeWidth={1} />
                <line x1={cx + 8} y1={cy + 6} x2={cx + 8} y2={cy + 6 + hoistDrop} stroke="#cbd5e1" strokeWidth={1.5} />

                {/* Heavy Spreader Beam with Corner Twist-Locks */}
                <g transform={`translate(${cx}, ${cy + 6 + hoistDrop})`}>
                  <rect x={-20} y={0} width={40} height={7} rx={2} fill="#eab308" stroke="#854d0e" strokeWidth={1} />
                  <line x1={-18} y1={7} x2={-18} y2={14} stroke="#1e293b" strokeWidth={2.5} />
                  <line x1={-6} y1={7} x2={-6} y2={14} stroke="#1e293b" strokeWidth={2.5} />
                  <line x1={6} y1={7} x2={6} y2={14} stroke="#1e293b" strokeWidth={2.5} />
                  <line x1={18} y1={7} x2={18} y2={14} stroke="#1e293b" strokeWidth={2.5} />

                  {/* Suspended High-Voltage Battery Pack on Hook */}
                  {carryingPack && (
                    <g transform="translate(0, 14)">
                      {(() => {
                        const pack = isoBox([0, 12], 22, 16, 18);
                        return (
                          <g>
                            <Solid box={pack} top="var(--ok)" left="#1e293b" right="#0f172a" />
                            <polygon points={pack.top} fill="var(--ok)" filter="url(#glow)" opacity={0.85} />
                            <line x1={pack.base.front[0] - 12} y1={pack.base.front[1] - 8} x2={pack.base.front[0] + 12} y2={pack.base.front[1] - 8} stroke="#34d399" strokeWidth={2.5} />
                          </g>
                        );
                      })()}
                    </g>
                  )}
                </g>
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
      </svg>

      {/* ----------------------------------------------------- overlays */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
          <ModelBadge />
          <Pill tone={site.dock.phase === "clear" ? "neutral" : "accent"} dot pulse={site.dock.phase !== "clear"}>
            {site.dock.caption}
          </Pill>
        </div>

        <div className="pointer-events-auto absolute right-3 top-3 flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            className="h-8 cursor-pointer rounded-lg border border-line bg-surface px-2.5 text-[12px] font-semibold text-ink-2 shadow-[var(--shadow)] transition hover:bg-surface-3 hover:text-ink"
          >
            {paused ? (enhanced ? "▶ Resume motion" : "▶ Resume") : (enhanced ? "❚❚ Pause motion" : "❚❚ Pause")}
          </button>
        </div>

        <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface/95 px-2.5 py-1.5 shadow-xl">
          {[
            ["var(--ok)", "Charging or delivering"],
            ["var(--warn)", "Generator running"],
            ["var(--ink-3)", "Vacant or idle"],
          ].map(([color, label]) => (
            <span key={label} className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
              <span className="h-2 w-2 rounded-full" style={{ background: color }} />
              {label}
            </span>
          ))}
          <span className="text-[11px] text-ink-3">· select a station, charger, generator, truck or occupied bay for details</span>
        </div>
      </div>
    </div>
  );
}

export { SITE_ASSETS };
