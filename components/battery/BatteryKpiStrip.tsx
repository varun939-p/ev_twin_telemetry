"use client";

import { KpiCard } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { chargingNow, deployedPacks, runningLoadKw } from "@/lib/fleet-metrics";
import type { TrustedVehicle } from "@/lib/trusted-telemetry";

/**
 * The four KPIs at the top of Battery Tracking.
 *
 * Replaces the deleted data-flow / forecaster / "Median Frame Age" cards.
 * Median Frame Age is NOT here by design — it is a pipeline health metric, not
 * a battery metric, and now lives on the Swap Station page.
 *
 * Tiles 2 and 4 are the interesting ones:
 *
 *   "Charging Right Now" counts frames whose `charging_status` is MEASURED and
 *   equal to 1. The tile links to the Charging Station operating draft.
 *
 *   "Current Running Load" is exactly
 *        Total Load (kW) = Σ (active charging packs × instantaneous power draw)
 *   with instantaneous draw = |battery_total_v × battery_current_a| / 1000.
 *
 * On today's two-tier v1 feed those three channels are absent on every frame,
 * so both reducers return null and the tiles render "awaiting upstream" with
 * the reason attached.  That is the correct answer: printing 0 kW would claim
 * the site is idle when the truth is that nobody is measuring it.  The moment
 * the backend provisions `chg_status` / `batt_v` / `batt_i`, both tiles light
 * up with no change to this file.
 */
export default function BatteryKpiStrip({
  packs,
  totalPacks,
}: {
  /** Packs in the current filter scope. */
  packs: TrustedVehicle[];
  /** Fleet-wide pack count, so tile 1 always states the asset base. */
  totalPacks: number;
}) {
  const charging = chargingNow(packs);
  const deployed = deployedPacks(packs);
  const load = runningLoadKw(packs);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label="Total Battery Assets"
        value={totalPacks}
        tone="neutral"
        hint={packs.length === totalPacks ? "Across the full live fleet" : `${packs.length} batteries match the current filters`}
      />

      <KpiCard
        label="Batteries Charging Right Now"
        value={charging.value}
        tone="info"
        unavailableReason="Awaiting live data"
        href="/digital-twin/charging-station"
        linkLabel="Open charging station"
      />

      <KpiCard
        label="Batteries Deployed in Service"
        value={deployed.value}
        tone="ok"
        unavailableReason="Awaiting live data"
        footer={
          deployed.value !== null && (
            <Pill tone="ok" dot pulse>
              mounted on moving carriers
            </Pill>
          )
        }
      />

      <KpiCard
        label="Current Charging Power Load"
        value={load.value}
        unit="kW"
        tone="info"
        unavailableReason="Awaiting live data"
        footer={
          load.activePacks > 0 && (
            <p className="num text-[11px] leading-snug text-ink-3">
              {load.activePacks} pack{load.activePacks !== 1 ? "s" : ""} charging
            </p>
          )
        }
      />
    </div>
  );
}
