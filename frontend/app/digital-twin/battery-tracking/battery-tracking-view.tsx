"use client";

/**
 * Battery Tracking — the tracked-asset lens.
 *
 * PAGE HIERARCHY (spec order)
 *   1. "Need Attention" banner — absolute top, battery-only anomalies
 *   2. Four KPIs (Median Frame Age deliberately NOT here; it is a pipeline
 *      metric and now lives on the Swap Station page)
 *   3. Station / region / SOC-bracket filters
 *   4. Battery register with the Carrier ID cross-link
 *   5. The three analytical generators
 *
 * The banner, the table and the charts all read one derived scope, and all
 * three write to the same pointer channel: hovering an alert highlights the
 * pack row; clicking a scatter point selects it and scrolls the table to it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import AttentionPanel from "@/components/alerts/AttentionPanel";
import BatteryFilterBar from "@/components/battery/BatteryFilterBar";
import BatteryKpiStrip from "@/components/battery/BatteryKpiStrip";
import BatteryTable from "@/components/battery/BatteryTable";
import TruckDetailModal from "@/components/truck/TruckDetailModal";
import { Card, CardHeader, Hairline, PageHeading } from "@/components/ui/Surface";
import PanelErrorBoundary from "@/components/ui/PanelErrorBoundary";
import { Pill } from "@/components/ui/Pill";
import {
  applyVehicleFilters,
  batteryRegistry,
  buildGeoIndex,
  deriveSites,
  isEvVehicle,
  nearestStation,
} from "@/lib/fleet";
import { SOC_CRITICAL, batteryAlerts, batteryRows, type BatteryRow } from "@/lib/fleet-metrics";
import { recordSocSamples } from "@/lib/soc-history";
import { useFilterState, useTwin } from "@/lib/store";
import { numericValue, orderedParams, type TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

export default function BatteryTrackingView({ data }: { data: TrustedTelemetryDocument }) {
  const filters = useFilterState();
  const select = useTwin((s) => s.select);
  const searchParams = useSearchParams();

  const vehicles = data.vehicles;
  const registry = useMemo(() => batteryRegistry(vehicles), [vehicles]);
  // Region options derived from the loaded fleet, not a static list of states.
  const geoIndex = useMemo(() => buildGeoIndex(vehicles), [vehicles]);

  /** Every pack in the fleet, before this page's filters. */
  /**
   * Selected pack for the 24-parameter modal. Deliberately the SAME component
   * the carrier table opens: the payload contract is per-frame, not per-page,
   * so a second "battery detail" modal would be a second thing to keep in
   * sync with the 24-parameter spec.
   */
  const [detail, setDetail] = useState<BatteryRow | null>(null);
  const params = useMemo(() => orderedParams(data), [data]);

  const allPacks = useMemo(() => vehicles.filter(isEvVehicle), [vehicles]);

  /** Operating sites derived from the payload — never a hardcoded hub list. */
  const sites = useMemo(() => deriveSites(vehicles), [vehicles]);

  /** Scope: pack frames only, narrowed by station / region / SOC bracket. */
  const scoped = useMemo(
    () => applyVehicleFilters(vehicles, { ...filters, ev: "ev" }, sites),
    [vehicles, filters, sites],
  );

  const rows = useMemo(() => batteryRows(scoped, registry, sites), [scoped, registry, sites]);
  const alerts = useMemo(() => batteryAlerts(scoped, registry, sites), [scoped, registry, sites]);

  const stationCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const pack of allPacks) {
      const station = nearestStation(pack, sites);
      if (station) counts[station.id] = (counts[station.id] ?? 0) + 1;
    }
    return counts;
  }, [allPacks, sites]);

  /**
   * Sample every pack's SOC as each document arrives, so the alert tooltips can
   * quote an OBSERVED rate of change rather than inventing one from a single
   * frame. Keyed on `generated_at`: a poll that returns an unchanged document
   * records nothing, and the sampler itself de-duplicates on `observed_at`.
   */
  useEffect(() => {
    recordSocSamples(
      allPacks.map((v) => ({
        vehicleId: v.vehicle_id,
        soc: numericValue(v, "soc"),
        observedAt: v.observed_at,
      })),
    );
  }, [allPacks, data.generated_at]);

  const criticalCount = rows.filter((r) => r.soc !== null && r.soc < SOC_CRITICAL).length;

  /* --------------------------------------------------------- deep links */

  /**
   * `?battery_id=<id>` from the truck table.
   * Resolved against BOTH the frame id and the display label ("Battery 7"),
   * so the link keeps working whichever identity a caller has to hand.
   */
  const handled = useRef<string | null>(null);
  const deepLink = searchParams.get("battery_id");

  useEffect(() => {
    if (!deepLink || handled.current === deepLink) return;
    const byId = vehicles.find((v) => v.vehicle_id === deepLink);
    const byLabel = !byId
      ? [...registry.entries()].find(([, id]) => id.label.toLowerCase() === deepLink.toLowerCase())?.[0]
      : undefined;
    const target = byId?.vehicle_id ?? byLabel;
    if (!target) return;
    handled.current = deepLink;
    select(target, "link");
  }, [deepLink, vehicles, registry, select]);

  const scopeLabel =
    scoped.length === allPacks.length
      ? `all ${allPacks.length} packs`
      : `${scoped.length} of ${allPacks.length} packs`;

  return (
    <div className="space-y-4">
      {/* 1 — alert banner, absolute top --------------------------------- */}
      <PanelErrorBoundary name="Battery alerts" resetKey={data.generated_at}>
        <AttentionPanel
          alerts={alerts}
          title="Need Attention — Batteries"
          emptyMessage="No pack anomalies in the current scope. Carrier alerts live on Truck Telemetry."
        />
      </PanelErrorBoundary>

      <PageHeading
        title="Battery Tracking"
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {criticalCount > 0 ? (
              <Pill tone="danger" dot pulse>
                {criticalCount} below {SOC_CRITICAL}% reserve
              </Pill>
            ) : (
              <Pill tone="ok" dot>
                No pack below the {SOC_CRITICAL}% reserve
              </Pill>
            )}
            <Pill tone="neutral">{scopeLabel}</Pill>
          </div>
        }
      />

      {/* 2 — the four KPIs ---------------------------------------------- */}
      <PanelErrorBoundary name="Battery KPIs" resetKey={data.generated_at}>
        <BatteryKpiStrip packs={scoped} totalPacks={allPacks.length} />
      </PanelErrorBoundary>

      {/* 3 — filters ----------------------------------------------------- */}
      <BatteryFilterBar
        sites={sites}
        stationCounts={stationCounts}
        geoIndex={geoIndex}
        scopedCount={rows.length}
        totalCount={allPacks.length}
      />

      {/* 4 — register ---------------------------------------------------- */}
      <Card>
        <CardHeader eyebrow="Asset register" title="Battery packs" />
        <Hairline />
        <PanelErrorBoundary name="Battery register" resetKey={data.generated_at}>
          <BatteryTable rows={rows} onKnowMore={setDetail} />
        </PanelErrorBoundary>
      </Card>

      <TruckDetailModal
        sites={sites}
        open={detail !== null}
        vehicle={detail?.vehicle ?? null}
        params={params}
        batteryLabel={detail?.batteryId ?? null}
        onClose={() => setDetail(null)}
      />
    </div>
  );
}
