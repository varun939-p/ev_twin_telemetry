"use client";

/**
 * Central Dashboard — the facility twin.
 *
 * Composition:
 *   1. Site selector + live strip (REAL telemetry: inbound carriers, packs
 *      below reserve, fleet in service, modelled site draw)
 *   2. The isometric site canvas — road, swap station (4 bays + crane),
 *      2 dual-gun chargers, backup DG, animated energy flow, live docking
 *   3. Inbound queue — real carriers with GPS-derived ETA to this hub
 *   4. Asset drill-down rail
 *
 * PROVENANCE SPLIT (the thing to be able to defend in the review)
 *   Everything in the strip and the inbound queue is derived from validated
 *   vehicle telemetry.  Bay charge levels, gun power, DG state and the crane
 *   are the FACILITY MODEL (`lib/site-model`), badged as such on the canvas,
 *   because the vehicle feed carries no site channels.  Pack identities inside
 *   the bays are real, so the model never invents an asset.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useRouter } from "next/navigation";

import FacilityPanels from "@/components/central/FacilityPanels";
import SiteCanvas from "@/components/central/SiteCanvas";
import { KpiCard } from "@/components/ui/Metric";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline, PageHeading } from "@/components/ui/Surface";
import PanelErrorBoundary from "@/components/ui/PanelErrorBoundary";
import SiteFilter, { usePersistedSiteSelection } from "@/components/central/SiteFilter";
import {
  deriveSites,
  batteryRegistry,
  formatEta,
  isEvVehicle,
  nearestStation,
  predictArrival,
  truckChassis,
} from "@/lib/fleet";
import { SOC_CRITICAL, assetStatus, batteryAlerts, truckAlerts } from "@/lib/fleet-metrics";
import AttentionPanel from "@/components/alerts/AttentionPanel";
import type { InboundSeed, PackSeed } from "@/lib/site-model";
import { numericValue, type TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

const DRILL_DOWNS = [
  { href: "/digital-twin/truck-telemetry", label: "Truck Telemetry", hint: "Carrier map, alerts, 24-param detail" },
  { href: "/digital-twin/battery-tracking", label: "Battery Tracking", hint: "Pack register, SOH, live SOC" },
];

export default function CentralView({ data }: { data: TrustedTelemetryDocument }) {
  const vehicles = data.vehicles;
  const router = useRouter();

  /**
   * Sites come from the payload, ordered by fleet presence. The toggle used to
   * be a two-element literal ("Pune", "Raurkela"); it now shows whatever the
   * API is actually reporting and defaults to the busiest site.
   */
  const sites = useMemo(() => deriveSites(vehicles), [vehicles]);
  const [selectedSiteIds, setSelectedSiteIds] = usePersistedSiteSelection(sites);
  const selectedSiteId = selectedSiteIds[0] ?? sites[0]?.id ?? "";
  const station = sites.find((s) => s.id === selectedSiteId) ?? sites[0] ?? null;
  const selectedVehicles = useMemo(() => {
    if (!selectedSiteIds.length) return [];
    return vehicles.filter((vehicle) => {
      const nearest = nearestStation(vehicle, sites);
      return nearest ? selectedSiteIds.includes(nearest.id) : false;
    });
  }, [vehicles, sites, selectedSiteIds]);
  const registry = useMemo(() => batteryRegistry(vehicles), [vehicles]);

  /** Packs whose nearest hub is the selected site — real identities + SOC. */
  const sitePacks = useMemo<PackSeed[]>(
    () =>
      selectedVehicles
        .filter((v) => isEvVehicle(v) && selectedSiteIds.includes(nearestStation(v, sites)?.id ?? ""))
        .map((v) => ({
          vehicleId: v.vehicle_id,
          batteryLabel: registry.get(v.vehicle_id)?.label ?? v.vehicle_id,
          soc: numericValue(v, "soc"),
        }))
        .sort((a, b) => (a.soc ?? 101) - (b.soc ?? 101)),
    [selectedVehicles, selectedSiteIds, registry, sites],
  );

  /** Carriers actually moving toward this hub, ordered by GPS-derived ETA. */
  const inbound = useMemo<InboundSeed[]>(
    () =>
      selectedVehicles
        .filter((v) => assetStatus(v) === "moving" && selectedSiteIds.includes(nearestStation(v, sites)?.id ?? ""))
        .map((v) => {
          const arrival = predictArrival(v, sites);
          return {
            vehicleId: v.vehicle_id,
            carrierLabel: truckChassis(v.vehicle_id),
            distanceKm: arrival.distanceKm,
            etaMinutes: arrival.etaMinutes,
            soc: numericValue(v, "soc"),
          };
        })
        .sort((a, b) => (a.etaMinutes ?? 1e9) - (b.etaMinutes ?? 1e9)),
    [selectedVehicles, selectedSiteIds, sites],
  );

  const inService = useMemo(() => selectedVehicles.filter((v) => assetStatus(v) === "moving").length, [selectedVehicles]);
  const belowReserve = useMemo(
    () => selectedVehicles.filter((v) => isEvVehicle(v) && (numericValue(v, "soc") ?? 100) < SOC_CRITICAL).length,
    [selectedVehicles],
  );
  const attentionAlerts = useMemo(() => [...batteryAlerts(selectedVehicles, registry, sites), ...truckAlerts(selectedVehicles, sites)], [selectedVehicles, registry, sites]);

  return (
    <div className="space-y-4">
      <PageHeading title="Central Dashboard" actions={<SiteFilter sites={sites} selected={selectedSiteIds} onChange={setSelectedSiteIds} />} />
      <Card>
        <div className="p-2 sm:p-3">
          <PanelErrorBoundary name="Facility canvas" resetKey={data.generated_at}>
            <SiteCanvas packs={sitePacks} inbound={inbound} station={station} />
          </PanelErrorBoundary>
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <KpiCard label="Trucks Incoming" value={inbound.length} tone="info" />
        <KpiCard label="Batteries at Site" value={sitePacks.length} tone="neutral" />
        <KpiCard label="Low Battery Alerts" value={belowReserve} tone={belowReserve > 0 ? "danger" : "ok"} />
        <KpiCard label="Active Trucks" value={inService} tone="ok" />
        <KpiCard label="Battery Reserve %" value={sitePacks.length ? Math.round(sitePacks.reduce((sum, pack) => sum + (pack.soc ?? 0), 0) / sitePacks.length) : null} unit="%" tone="accent" />
      </div>
      <PanelErrorBoundary name="Facility panels" resetKey={data.generated_at}>
        <FacilityPanels packs={sitePacks} inbound={inbound} station={station} />
      </PanelErrorBoundary>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader eyebrow="Arrivals" title="Inbound carriers" actions={<Pill tone="neutral">{inbound.length} moving</Pill>} />
          <Hairline />
          {inbound.length === 0 ? <p className="px-5 py-8 text-center text-xs text-ink-3">No carriers are currently moving toward the selected sites.</p> : <ul className="scroll-thin max-h-[260px] divide-y divide-line overflow-y-auto">{inbound.slice(0, 12).map((truck) => <li key={truck.vehicleId}><Link href={`/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(truck.vehicleId)}`} className="flex items-center gap-3 px-5 py-2.5 transition hover:bg-surface-2"><span className="num min-w-0 flex-1 truncate text-xs font-medium text-ink">{truck.carrierLabel}</span><span className="num text-[12px] text-ink-2">{truck.soc === null ? "SOC —" : `SOC ${truck.soc}%`}</span><span className="num text-[12px] text-ink-3">{truck.distanceKm ?? "—"} km</span><Pill tone="info">{formatEta(truck.etaMinutes) ?? "ETA —"}</Pill></Link></li>)}</ul>}
        </Card>
        <Card><CardHeader eyebrow="Navigate" title="Asset telemetry" description="Open a detailed view for the selected fleet." /><Hairline /><ul className="divide-y divide-line">{DRILL_DOWNS.map((item) => <li key={item.href}><Link href={item.href} className="flex items-center gap-3 px-5 py-3 transition hover:bg-surface-2"><span className="min-w-0 flex-1"><span className="block text-xs font-medium text-ink">{item.label}</span><span className="block text-[11px] text-ink-3">{item.hint}</span></span><span className="text-accent" aria-hidden>→</span></Link></li>)}</ul></Card>
      </div>
      <PanelErrorBoundary name="Combined attention" resetKey={data.generated_at}>
        <AttentionPanel alerts={attentionAlerts} title="Need Attention — Fleet" emptyMessage="All selected batteries and trucks are within the current operating thresholds." onRowClick={(vehicleId) => router.push(`/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(vehicleId)}`)} />
      </PanelErrorBoundary>
    </div>
  );
}
