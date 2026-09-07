/**
 * Facility model for the Central Dashboard site canvas + the Swap Station draft.
 *
 * HONESTY BOUNDARY (read before extending)
 * ----------------------------------------
 * The validated vehicle feed carries NO facility telemetry: there is no bay
 * occupancy channel, no charger gun state, no DG contactor, no crane position.
 * Rendering those as if they were live readings would be exactly the
 * fabrication `lib/trusted-telemetry` exists to prevent.
 *
 * So this module is explicitly a MODEL, and it is kept in one file so the
 * boundary is auditable:
 *
 *   * Everything it returns is tagged `modelled: true` and the canvas paints a
 *     "FACILITY MODEL" badge over any surface driven by it.
 *   * It is a pure function of `(tick, packs)` — no `Math.random()`, no
 *     `Date.now()` — so the server render and the first client render are
 *     byte-identical and hydration cannot mismatch.  Motion comes from the
 *     host component incrementing `tick`.
 *   * Where real data DOES exist it is injected rather than invented: bay
 *     occupants carry real `Battery N` identities and their real measured SOC,
 *     and inbound trucks are real carriers with real GPS-derived ETAs.
 *
 * When the site controller starts publishing, replace `simulateSite` with a
 * fetch of the same `SiteState` shape and delete nothing else.
 */

import type { SwapStation } from "@/lib/fleet";

/* ------------------------------------------------------------------ layout */

export type SiteAssetKind = "swap-station" | "bay" | "charger" | "dg" | "grid" | "gate";

/** Where each asset sits on the isometric canvas + where clicking it goes. */
export interface SiteAssetSpec {
  id: string;
  kind: SiteAssetKind;
  label: string;
  /**
   * Drill-down target, or `null` for assets with no page of their own.
   * Chargers, the DG and the grid feeder are `null` since their routes were
   * pulled out into a separate workstream; the canvas renders them as
   * informational geometry rather than dead links.
   */
  href: string | null;
  /** Isometric anchor in canvas units (the SVG is 1200 x 680). */
  x: number;
  y: number;
}

export const SITE_ASSETS: readonly SiteAssetSpec[] = [
  { id: "swap-station", kind: "swap-station", label: "Swap Station", href: "/digital-twin/swap-station/overview", x: 600, y: 250 },
  // Bays resolve to the PACK they hold, so the canvas hands off to the pack
  // register with a battery already selected. Vacant bays are inert.
  { id: "bay-1", kind: "bay", label: "Bay 1", href: "/digital-twin/battery-tracking", x: 470, y: 300 },
  { id: "bay-2", kind: "bay", label: "Bay 2", href: "/digital-twin/battery-tracking", x: 555, y: 300 },
  { id: "bay-3", kind: "bay", label: "Bay 3", href: "/digital-twin/battery-tracking", x: 640, y: 300 },
  { id: "bay-4", kind: "bay", label: "Bay 4", href: "/digital-twin/battery-tracking", x: 725, y: 300 },
  { id: "charger-a", kind: "charger", label: "Dual-gun Charger A", href: "/digital-twin/charging-station", x: 300, y: 430 },
  { id: "charger-b", kind: "charger", label: "Dual-gun Charger B", href: "/digital-twin/charging-station", x: 430, y: 470 },
  { id: "dg", kind: "dg", label: "Backup Diesel Generator", href: "/digital-twin/dg/overview", x: 930, y: 420 },
  { id: "grid", kind: "grid", label: "Grid Feeder", href: null, x: 930, y: 250 },
];

/* ------------------------------------------------------------- model input */

/** A real pack, injected so the model never invents a battery identity. */
export interface PackSeed {
  vehicleId: string;
  batteryLabel: string;
  soc: number | null;
}

/** A real carrier heading for this site, from measured GPS + SOC. */
export interface InboundSeed {
  vehicleId: string;
  carrierLabel: string;
  distanceKm: number | null;
  etaMinutes: number | null;
  soc: number | null;
}

/* ------------------------------------------------------------- model state */

export type BayStatus = "charging" | "full" | "vacant" | "dispatching";

export interface BayState {
  id: string;
  index: number;
  status: BayStatus;
  /** 0-100, modelled charge progression; null when the bay is empty. */
  soc: number | null;
  batteryLabel: string | null;
  vehicleId: string | null;
  /** Modelled charge power into this bay (kW); 0 when not charging. */
  kw: number;
  /** Minutes to 100% at the modelled rate; null when not charging. */
  minutesToFull: number | null;
}

export type GunStatus = "delivering" | "handshake" | "idle" | "fault";

export interface GunState {
  id: string;
  label: string;
  status: GunStatus;
  kw: number;
}

export interface ChargerState {
  id: string;
  label: string;
  href: string | null;
  guns: GunState[];
  totalKw: number;
  ratedKw: number;
}

export interface DgState {
  running: boolean;
  loadKw: number;
  ratedKw: number;
  fuelPct: number;
  reason: string;
}

export interface GridState {
  importKw: number;
  feederKw: number;
  /** true when modelled demand exceeds the feeder and the DG picks up. */
  constrained: boolean;
}

export type DockPhase = "clear" | "approach" | "docking" | "swapping" | "release" | "departure";

export interface DockState {
  phase: DockPhase;
  /** 0..1 along the current phase — drives the truck's position on the road. */
  progress: number;
  /** 0..1 along the full entry->exit road path. */
  roadT: number;
  /** Crane travel 0..1 across the bay gantry. */
  craneT: number;
  /** Crane hoist 0..1 (0 = up, 1 = lowered onto the truck). */
  hoistT: number;
  truck: InboundSeed | null;
  caption: string;
}

export interface SiteState {
  modelled: true;
  station: SwapStation | null;
  bays: BayState[];
  chargers: ChargerState[];
  dg: DgState;
  grid: GridState;
  dock: DockState;
  /** Sum of modelled bay + gun power — what the flow lines animate on. */
  totalDrawKw: number;
}

/* --------------------------------------------------------------- internals */

/** Deterministic 0..1 from an integer pair — no RNG, so SSR === CSR at tick 0. */
function noise(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

const CYCLE_TICKS = 72; // one full arrive -> swap -> depart loop
const BAY_RATED_KW = 60;
const GUN_RATED_KW = 120;

/**
 * Where the dock sits along the road polyline, as a fraction of its length.
 *
 * Exported so the canvas geometry and the state machine cannot drift apart:
 * `SiteCanvas` positions the truck by sampling its road path at `roadT`, and
 * the bay apron is drawn at exactly this fraction.  Change the road shape and
 * only this constant needs to follow.
 */
export const ROAD_DOCK_T = 0.45;

function dockAt(tick: number, truck: InboundSeed | null): DockState {
  const t = ((tick % CYCLE_TICKS) + CYCLE_TICKS) % CYCLE_TICKS;
  const seg = (from: number, to: number) => Math.min(Math.max((t - from) / (to - from), 0), 1);
  const D = ROAD_DOCK_T;

  if (t < 8) {
    return { phase: "clear", progress: seg(0, 8), roadT: 0, craneT: 0.5, hoistT: 0, truck, caption: "Lane clear — no swap transaction active" };
  }
  if (t < 22) {
    const p = seg(8, 22);
    return { phase: "approach", progress: p, roadT: p * (D - 0.03), craneT: 0.5, hoistT: 0, truck, caption: "Carrier inbound on the entry lane" };
  }
  if (t < 30) {
    const p = seg(22, 30);
    return { phase: "docking", progress: p, roadT: D - 0.03 + p * 0.03, craneT: 0.5 - p * 0.2, hoistT: p * 0.3, truck, caption: "Docking at the swap bay — alignment lock" };
  }
  if (t < 50) {
    const p = seg(30, 50);
    // Crane runs bay -> truck -> bay while the pack is exchanged.
    const craneT = p < 0.5 ? 0.3 - p * 0.4 : (p - 0.5) * 0.6;
    return { phase: "swapping", progress: p, roadT: D, craneT: Math.abs(craneT), hoistT: 0.55 + Math.sin(p * Math.PI * 2) * 0.35, truck, caption: "Swap in progress — crane exchanging pack" };
  }
  if (t < 58) {
    const p = seg(50, 58);
    return { phase: "release", progress: p, roadT: D + p * 0.04, craneT: 0.5, hoistT: 0.3 * (1 - p), truck, caption: "Pack seated — releasing dock clamps" };
  }
  const p = seg(58, CYCLE_TICKS);
  return { phase: "departure", progress: p, roadT: D + 0.04 + p * (1 - D - 0.04), craneT: 0.5, hoistT: 0, truck, caption: "Carrier departing on the exit lane" };
}

/* ------------------------------------------------------------------ public */

/**
 * Build the whole facility state for a given tick.
 *
 * @param tick   monotonically increasing integer (1 Hz in the canvas)
 * @param packs  real packs nearest this site — supplies bay identities + SOC
 * @param inbound real carriers approaching — supplies the docking truck + ETA
 */
export function simulateSite(
  tick: number,
  packs: PackSeed[],
  inbound: InboundSeed[],
  station: SwapStation | null,
): SiteState {
  const dock = dockAt(tick, inbound[0] ?? null);

  /* --- bays: real pack identity + measured SOC, modelled progression ------ */
  const bays: BayState[] = SITE_ASSETS.filter((a) => a.kind === "bay").map((asset, i) => {
    const seed = packs[i];
    // Bay 4 is deliberately the vacant one until the docking truck's pack
    // lands in it, which is what makes the dock animation legible.
    const receiving = i === 3;
    const occupied = seed !== undefined && (!receiving || dock.phase === "swapping" || dock.phase === "release");

    if (!occupied) {
      return { id: asset.id, index: i + 1, status: "vacant", soc: null, batteryLabel: null, vehicleId: null, kw: 0, minutesToFull: null };
    }

    // Measured SOC is the floor; the model walks it up at the bay's rate.
    const base = seed.soc ?? 40 + Math.round(noise(i, 7) * 30);
    const climb = ((tick * (1.4 + noise(i, 3))) % 100) * 0.55;
    const soc = Math.min(100, Math.round(base + (receiving ? 0 : climb * (1 - base / 140))));
    const full = soc >= 100;
    const dispatching = !full && dock.phase === "swapping" && i === 0;
    const kw = full ? 0 : Math.round(BAY_RATED_KW * (0.55 + 0.45 * (1 - soc / 100)) * (0.9 + noise(i, tick % 11) * 0.2));

    return {
      id: asset.id,
      index: i + 1,
      status: dispatching ? "dispatching" : full ? "full" : "charging",
      soc,
      batteryLabel: seed.batteryLabel,
      vehicleId: seed.vehicleId,
      kw: full ? 0 : kw,
      minutesToFull: full ? null : Math.max(1, Math.round(((100 - soc) / 100) * 282 / Math.max(kw, 1) * 60)),
    };
  });

  /* --- chargers: 2 units, 2 guns each ------------------------------------ */
  const chargers: ChargerState[] = (["charger-a", "charger-b"] as const).map((id, ci) => {
    const spec = SITE_ASSETS.find((a) => a.id === id)!;
    const guns: GunState[] = [0, 1].map((gi) => {
      const phase = (tick + ci * 9 + gi * 17) % 40;
      const status: GunStatus = phase < 4 ? "handshake" : phase < 30 ? "delivering" : "idle";
      const kw =
        status === "delivering"
          ? Math.round(GUN_RATED_KW * (0.45 + 0.5 * noise(ci * 2 + gi, Math.floor(tick / 4))))
          : 0;
      return { id: `${id}-gun-${gi + 1}`, label: `Gun ${gi + 1}`, status, kw };
    });
    return {
      id,
      label: spec.label,
      href: spec.href,
      guns,
      totalKw: guns.reduce((s, g) => s + g.kw, 0),
      ratedKw: GUN_RATED_KW * 2,
    };
  });

  /* --- grid + DG ---------------------------------------------------------- */
  const bayKw = bays.reduce((s, b) => s + b.kw, 0);
  const gunKw = chargers.reduce((s, c) => s + c.totalKw, 0);
  const totalDrawKw = Math.round(bayKw + gunKw);
  const feederKw = 250;
  const constrained = totalDrawKw > feederKw;
  const dgLoad = constrained ? Math.round(totalDrawKw - feederKw) : 0;

  return {
    modelled: true,
    station,
    bays,
    chargers,
    dg: {
      running: constrained,
      loadKw: dgLoad,
      ratedKw: 125,
      fuelPct: Math.max(20, 92 - ((tick / 60) % 70)),
      reason: constrained
        ? `Site demand ${totalDrawKw} kW exceeds the ${feederKw} kW feeder — DG picking up ${dgLoad} kW`
        : `Standby — site demand ${totalDrawKw} kW is inside the ${feederKw} kW feeder limit`,
    },
    grid: { importKw: Math.min(totalDrawKw, feederKw), feederKw, constrained },
    dock,
    totalDrawKw,
  };
}
