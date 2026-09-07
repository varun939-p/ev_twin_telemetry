"use client";

/**
 * The three operational panels management mandated, restored to the Central
 * Dashboard (the old /swap-station, /chargers and /dg routes fed these views
 * before they were collapsed into the canvas):
 *
 *   1. Swap Station Operations — bay occupancy, the ACTIVE transaction, and
 *      the vehicle queue building up at the gate.
 *   2. Charger Status — dual-gun Charger A/B, per-gun delivery in kW.
 *   3. Grid/DG Power Load — site draw vs the grid feeder, DG pickup.
 *
 * PROVENANCE (same boundary as lib/site-model.ts — read before extending):
 * the validated vehicle feed carries NO facility channels, so state that
 * comes from the facility model is badged "FACILITY MODEL". Real data is
 * injected wherever it exists: bay occupants carry real Battery identities
 * and measured SOC; the queue is real inbound carriers with GPS-derived ETAs;
 * the active transaction truck is a real carrier. Nothing is fabricated.
 *
 * Rendering contract: the panel owns a 1 Hz tick fed to the pure
 * `simulateSite()` reducer. First render (server + client) is tick 0, so
 * hydration matches; the interval never runs on the server.
 */

import { useEffect, useMemo, useState } from "react";

import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline } from "@/components/ui/Surface";
import type { BayState, ChargerState } from "@/lib/site-model";
import { simulateSite, type InboundSeed, type PackSeed } from "@/lib/site-model";
import type { SwapStation } from "@/lib/fleet";
import { formatEta } from "@/lib/fleet";

const MODEL_BADGE = (
  <Pill tone="neutral" className="!text-[10px]">
    Facility model
  </Pill>
);

const BAY_TONE: Record<BayState["status"], string> = {
  charging: "bg-ok",
  full: "bg-accent",
  vacant: "bg-ink-3",
  dispatching: "bg-warn",
};

const GUN_TONE: Record<ChargerState["guns"][number]["status"], string> = {
  delivering: "bg-ok",
  handshake: "bg-warn",
  idle: "bg-ink-3",
  fault: "bg-danger",
};

function KwBar({ kw, rated, tone }: { kw: number; rated: number; tone: string }) {
  const pct = rated > 0 ? Math.min(100, Math.round((kw / rated) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={`h-full rounded-full ${tone} transition-[width] duration-700`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function FacilityPanels({
  packs,
  inbound,
  station,
}: {
  packs: PackSeed[];
  inbound: InboundSeed[];
  station: SwapStation | null;
}) {
  const [tick, setTick] = useState(0);

  // 1 Hz sim clock — identical contract to SiteCanvas (tick 0 = shared frame).
  useEffect(() => {
    const reduced =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const site = useMemo(() => simulateSite(tick, packs, inbound, station), [tick, packs, inbound, station]);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      {/* 1 — SWAP STATION OPERATIONS ------------------------------------- */}
      <Card>
        <CardHeader
          eyebrow="Swap station"
          title={station?.name ?? "Bay operations"}
          actions={MODEL_BADGE}
        />
        <Hairline />

        {/* the ACTIVE transaction, straight off the dock state machine */}
        <div className="flex items-center gap-2 px-5 pt-3">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              site.dock.phase === "swapping"
                ? "bg-ok animate-pulse"
                : site.dock.phase === "clear"
                  ? "bg-ink-3"
                  : "bg-warn"
            }`}
            aria-hidden
          />
          <p className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
            {site.dock.truck ? `${site.dock.truck.carrierLabel} — ${site.dock.caption}` : site.dock.caption}
          </p>
        </div>

        {/* bay occupancy — real packs, measured SOC, modelled progression */}
        <ul className="mt-2 divide-y divide-line">
          {site.bays.map((bay) => (
            <li key={bay.id} className="flex items-center gap-3 px-5 py-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${BAY_TONE[bay.status]}`} aria-hidden />
              <span className="w-12 shrink-0 text-[11px] font-semibold text-ink-2">Bay {bay.index}</span>
              <span className="num min-w-0 flex-1 truncate text-[12px] text-ink">
                {bay.batteryLabel ?? <span className="text-ink-3">vacant</span>}
              </span>
              {bay.soc !== null ? (
                <>
                  <span className="num w-10 text-right text-[11px] text-ink-2">{bay.soc}%</span>
                  <span className="w-16">
                    <KwBar kw={bay.soc} rated={100} tone={bay.status === "full" ? "bg-accent" : "bg-ok"} />
                  </span>
                  <span className="num w-16 text-right text-[11px] text-ink-3">
                    {bay.kw > 0 ? `${bay.kw} kW` : bay.status === "full" ? "ready" : "—"}
                  </span>
                </>
              ) : (
                <span className="num flex-1 text-right text-[11px] text-ink-3">awaiting pack</span>
              )}
            </li>
          ))}
        </ul>

        {/* the queue: real inbound carriers waiting to dock */}
        <div className="border-t border-line px-5 py-2.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold tracking-[0.08em] text-ink-3">Vehicle queue</p>
            <Pill tone={inbound.length > 0 ? "info" : "neutral"}>{inbound.length} inbound</Pill>
          </div>
          {inbound.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {inbound.slice(0, 3).map((truck) => (
                <li key={truck.vehicleId} className="flex items-center justify-between text-[11px]">
                  <span className="num truncate text-ink-2">{truck.carrierLabel}</span>
                  <span className="num text-ink-3">
                    {truck.soc === null ? "SOC —" : `SOC ${truck.soc}%`} · {formatEta(truck.etaMinutes) ?? "ETA —"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* 2 — CHARGER STATUS ---------------------------------------------- */}
      <Card>
        <CardHeader eyebrow="Chargers" title="Dual-gun charging" actions={MODEL_BADGE} />
        <Hairline />
        <div className="space-y-3 px-5 py-3">
          {site.chargers.map((charger) => (
            <div key={charger.id}>
              <div className="flex items-baseline justify-between">
                <p className="text-[12px] font-semibold text-ink">
                  Charger {charger.id === "charger-a" ? "A" : "B"}
                </p>
                <p className="num text-[11px] text-ink-2">
                  {charger.totalKw} / {charger.ratedKw} kW
                </p>
              </div>
              <div className="mt-1.5">
                <KwBar kw={charger.totalKw} rated={charger.ratedKw} tone="bg-ok" />
              </div>
              <ul className="mt-1.5 space-y-1">
                {charger.guns.map((gun) => (
                  <li key={gun.id} className="flex items-center gap-2 text-[11px]">
                    <span className={`h-1.5 w-1.5 rounded-full ${GUN_TONE[gun.status]}`} aria-hidden />
                    <span className="flex-1 text-ink-2">{gun.label}</span>
                    <span className="text-ink-3 capitalize">{gun.status}</span>
                    <span className="num w-16 text-right font-semibold text-ink">
                      {gun.kw > 0 ? `${gun.kw} kW` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="border-t border-line pt-2 text-[10.5px] leading-relaxed text-ink-3">
            Bay + gun load is modelled until the site controller publishes charger telemetry. Bay occupants are real
            packs with measured SOC.
          </p>
        </div>
      </Card>

      {/* 3 — GRID / DG POWER LOAD ---------------------------------------- */}
      <Card>
        <CardHeader
          eyebrow="Power"
          title="Grid & DG load"
          actions={
            <>
              <Pill tone={site.dg.running ? "warn" : "ok"} dot pulse={site.dg.running}>
                {site.dg.running ? "DG assisting" : "Grid stable"}
              </Pill>
              {MODEL_BADGE}
            </>
          }
        />
        <Hairline />
        <div className="space-y-3 px-5 py-3">
          <div>
            <div className="flex items-baseline justify-between">
              <p className="text-[12px] font-semibold text-ink">Site draw</p>
              <p className="num text-[12px] font-semibold text-ink">{site.totalDrawKw} kW</p>
            </div>
            <p className="mt-0.5 text-[10.5px] text-ink-3">bays {site.bays.reduce((s, b) => s + b.kw, 0)} kW · guns {site.chargers.reduce((s, c) => s + c.totalKw, 0)} kW</p>
          </div>

          <div>
            <div className="flex items-baseline justify-between text-[11px]">
              <p className="font-semibold text-ink-2">Grid import</p>
              <p className="num text-ink-2">
                {site.grid.importKw} / {site.grid.feederKw} kW
              </p>
            </div>
            <div className="mt-1.5">
              <KwBar kw={site.grid.importKw} rated={site.grid.feederKw} tone={site.grid.constrained ? "bg-danger" : "bg-ok"} />
            </div>
          </div>

          <div className={`rounded-lg border p-2.5 ${site.dg.running ? "border-warn/40 bg-warn-soft" : "border-line bg-surface-2"}`}>
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-semibold text-ink">Diesel generator</p>
              <p className="num text-[11px] text-ink-2">
                {site.dg.running ? `${site.dg.loadKw} / ${site.dg.ratedKw} kW` : "Standby"}
              </p>
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-3">{site.dg.reason}</p>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-[10.5px] text-ink-3">Fuel</span>
              <div className="flex-1">
                <KwBar kw={site.dg.fuelPct} rated={100} tone="bg-warn" />
              </div>
              <span className="num text-[10.5px] text-ink-2">{Math.round(site.dg.fuelPct)}%</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
