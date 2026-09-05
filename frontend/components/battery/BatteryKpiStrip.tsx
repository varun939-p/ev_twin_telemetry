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
 *   equal to 1.  The whole tile is a <Link> to the Swap Station route.
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

  const scopeNote = packs.length === totalPacks ? "across the whole fleet" : `in the filtered scope of ${packs.length}`;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label="Total battery assets"
        value={packs.length}
        hint={
          packs.length === totalPacks
            ? `${totalPacks} packs reporting validated pack telemetry`
            : `${packs.length} of ${totalPacks} packs match the current filters`
        }
        tone="neutral"
      />

      {/* The old click-through target (/digital-twin/swap-station) was removed
          with the draft routes, so this card no longer pretends to navigate. */}
      <KpiCard
        label="Batteries charging right now"
        value={charging.value}
        tone="info"
        hint={charging.note}
        unavailableReason={charging.note}
      />

      <KpiCard
        label="Deployed / in service"
        value={deployed.value}
        tone="ok"
        hint={deployed.note}
        unavailableReason={deployed.note}
        footer={
          deployed.value !== null && (
            <Pill tone="ok" dot pulse>
              mounted on moving carriers
            </Pill>
          )
        }
      />

      <KpiCard
        label="Current running load"
        value={load.value}
        unit="kW"
        tone="info"
        hint={load.note}
        unavailableReason={load.note}
        footer={
          <p className="num text-[11px] leading-snug text-ink-3">
            Σ(active packs × |V×I|/1000) {scopeNote}
            {load.activePacks > 0 && ` · ${load.activePacks} active`}
          </p>
        }
      />
    </div>
  );
}
