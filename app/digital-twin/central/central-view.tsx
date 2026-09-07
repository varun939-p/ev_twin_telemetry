"use client";

/**
 * Central Dashboard — one filtered operational view across the live fleet.
 *
 * The authenticated fetch stays in the server page. This component only
 * derives presentation scopes after the trusted document arrives: one atomic
 * site selection feeds the original facility model, KPIs, arrivals and the
 * combined alert queue.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";

import AttentionPanel from "@/components/alerts/AttentionPanel";
import SiteCanvas from "@/components/central/SiteCanvas";
import SiteFilter from "@/components/central/SiteFilter";
import { KpiCard } from "@/components/ui/Metric";
import PanelErrorBoundary from "@/components/ui/PanelErrorBoundary";
import { Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline, PageHeading } from "@/components/ui/Surface";
import {
  batteryRegistry,
  deriveSites,
  formatEta,
  isEvVehicle,
  nearestStation,
  predictArrival,
  truckChassis,
  type SwapStation,
} from "@/lib/fleet";
import {
  SOC_CRITICAL,
  assetStatus,
  batteryAlerts,
  truckAlerts,
  type TwinAlert,
} from "@/lib/fleet-metrics";
import { usePersistedString } from "@/lib/persisted";
import type { InboundSeed, PackSeed } from "@/lib/site-model";
import {
  numericValue,
  parseTimestampMs,
  type TrustedTelemetryDocument,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";

const SITE_SELECTION_KEY = "twin.central.selected-sites.v3";

/** Canonical site directory, used only when no location-bearing frames exist. */
const FALLBACK_SITES: readonly SwapStation[] = [
  { id: "pune-hub-plant", name: "Pune (Hub & Plant)", state: "Maharashtra", lat: 18.5204, lon: 73.8567, bays: 4, assetCount: 0 },
  { id: "udaipur", name: "Udaipur", state: "Rajasthan", lat: 24.585, lon: 73.7125, bays: 4, assetCount: 0 },
  { id: "kota", name: "Kota", state: "Rajasthan", lat: 25.2138, lon: 75.8648, bays: 4, assetCount: 0 },
  { id: "rourkela", name: "Rourkela", state: "Odisha", lat: 22.2601, lon: 84.83, bays: 4, assetCount: 0 },
  { id: "chennai", name: "Chennai", state: "Tamil Nadu", lat: 13.0827, lon: 80.2707, bays: 4, assetCount: 0 },
  { id: "delhi-ncr", name: "Delhi NCR", state: "Delhi", lat: 28.6139, lon: 77.209, bays: 4, assetCount: 0 },
  { id: "kolkata", name: "Kolkata", state: "West Bengal", lat: 22.5726, lon: 88.3639, bays: 4, assetCount: 0 },
  { id: "mumbai", name: "Mumbai", state: "Maharashtra", lat: 19.076, lon: 72.8777, bays: 4, assetCount: 0 },
];

const ALERT_RANK = { critical: 0, warning: 1, info: 2 } as const;
const ARRIVAL_RADIUS_KM = 50;

function readStoredIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface ArrivalRow extends InboundSeed {
  origin: string;
}

function arrivalOrigin(vehicle: TrustedVehicle): string {
  const reported = (vehicle as TrustedVehicle & { origin?: unknown }).origin;
  return typeof reported === "string" && reported.trim() ? reported.trim() : "Unavailable";
}

export default function CentralView({ data }: { data: TrustedTelemetryDocument }) {
  const router = useRouter();
  const vehicles = data.vehicles;
  const derivedSites = useMemo(() => deriveSites(vehicles), [vehicles]);
  const sites = derivedSites.length > 0 ? derivedSites : FALLBACK_SITES;
  const registry = useMemo(() => batteryRegistry(vehicles), [vehicles]);

  const [storedSelection, persistSelection] = usePersistedString(SITE_SELECTION_KEY);
  const storedIds = useMemo(() => readStoredIds(storedSelection), [storedSelection]);
  const selectedSiteIds = useMemo(() => {
    const storedSite = sites.find((site) => site.id === storedIds[0]);
    if (storedSite) return [storedSite.id];
    const pune = sites.find((site) => site.name.toLowerCase().includes("pune"));
    return sites.length > 0 ? [pune?.id ?? sites[0].id] : [];
  }, [sites, storedIds]);

  const changeSites = useCallback(
    (ids: string[]) => persistSelection(JSON.stringify(ids)),
    [persistSelection],
  );

  const selectedSet = useMemo(() => new Set(selectedSiteIds), [selectedSiteIds]);
  const selectedSites = useMemo(
    () => sites.filter((site) => selectedSet.has(site.id)),
    [selectedSet, sites],
  );

  /** One GPS assignment pass; every downstream panel reuses the result. */
  const scopedVehicles = useMemo(
    () =>
      vehicles.filter((vehicle) => {
        const site = nearestStation(vehicle, sites);
        return site !== null && selectedSet.has(site.id);
      }),
    [selectedSet, sites, vehicles],
  );

  const sceneStation = useMemo<SwapStation | null>(() => {
    const first = selectedSites[0] ?? null;
    if (!first || selectedSites.length === 1) return first;
    return {
      ...first,
      name: `${selectedSites.length}-site operating view`,
      assetCount: scopedVehicles.length,
    };
  }, [scopedVehicles.length, selectedSites]);

  const sitePacks = useMemo<PackSeed[]>(
    () =>
      scopedVehicles
        .filter(isEvVehicle)
        .map((vehicle) => ({
          vehicleId: vehicle.vehicle_id,
          batteryLabel: registry.get(vehicle.vehicle_id)?.label ?? vehicle.vehicle_id,
          soc: numericValue(vehicle, "soc"),
        }))
        .sort((a, b) => (a.soc ?? 101) - (b.soc ?? 101)),
    [registry, scopedVehicles],
  );

  /** Moving carriers enter Arrivals only inside the site's 50 km operating radius. */
  const inbound = useMemo<ArrivalRow[]>(
    () =>
      scopedVehicles
        .filter((vehicle) => assetStatus(vehicle) === "moving")
        .map((vehicle) => {
          const arrival = predictArrival(vehicle, sites);
          return {
            vehicleId: vehicle.vehicle_id,
            carrierLabel: truckChassis(vehicle.vehicle_id),
            origin: arrivalOrigin(vehicle),
            distanceKm: arrival.distanceKm,
            etaMinutes: arrival.etaMinutes,
            soc: numericValue(vehicle, "soc"),
          };
        })
        .filter((truck) => truck.distanceKm !== null && truck.distanceKm <= ARRIVAL_RADIUS_KM)
        .sort((a, b) => (a.etaMinutes ?? Number.POSITIVE_INFINITY) - (b.etaMinutes ?? Number.POSITIVE_INFINITY)),
    [scopedVehicles, sites],
  );

  const activeTrucks = useMemo(
    () => scopedVehicles.filter((vehicle) => assetStatus(vehicle) === "moving").length,
    [scopedVehicles],
  );
  const lowBatteryAlerts = useMemo(
    () => sitePacks.filter((pack) => pack.soc !== null && pack.soc < SOC_CRITICAL).length,
    [sitePacks],
  );

  /** Anchor alert ages to the document, so SSR and hydration see one instant. */
  const documentNow = useMemo(() => {
    const timestamp = parseTimestampMs(data.generated_at);
    return Number.isFinite(timestamp) ? new Date(timestamp) : new Date(0);
  }, [data.generated_at]);

  const combinedAlerts = useMemo(
    () =>
      [
        ...batteryAlerts(scopedVehicles, registry, sites, documentNow),
        ...truckAlerts(scopedVehicles, sites, documentNow),
      ].sort((a, b) => ALERT_RANK[a.severity] - ALERT_RANK[b.severity]),
    [documentNow, registry, scopedVehicles, sites],
  );

  const openAlert = useCallback(
    (alert: TwinAlert) => {
      const path =
        alert.scope === "battery"
          ? `/digital-twin/battery-tracking?battery_id=${encodeURIComponent(alert.vehicleId)}`
          : `/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(alert.vehicleId)}`;
      router.push(path);
    },
    [router],
  );

  return (
    <div className="space-y-4">
      {/* Page header + persistent, touch-native site scope. */}
      <header className="space-y-3">
        <PageHeading
          title="Central Dashboard"
          actions={
            <Pill tone="ok" dot pulse>
              {scopedVehicles.length} assets in view
            </Pill>
          }
        />
        <SiteFilter sites={sites} selectedIds={selectedSiteIds} onChange={changeSites} />
      </header>

      {/* Original Central facility visualization, driven by the selected scope. */}
      <Card>
        <div className="p-2 sm:p-3">
          <PanelErrorBoundary name="Facility visualization" resetKey={data.generated_at}>
            <SiteCanvas packs={sitePacks} inbound={inbound} station={sceneStation} appearance="original" />
          </PanelErrorBoundary>
        </div>
      </Card>

      {/* Executive KPI row, all computed from the same selected site scope. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Inbound Carriers"
          value={inbound.length}
          tone="info"
          href="/digital-twin/truck-telemetry"
          linkLabel="View inbound carriers"
        />
        <KpiCard
          label="Batteries at Site"
          value={sitePacks.length}
          tone="neutral"
          href="/digital-twin/battery-tracking"
          linkLabel="View battery assets"
        />
        <KpiCard
          label="Fleet in Service"
          value={activeTrucks}
          tone="ok"
          href="/digital-twin/truck-telemetry"
          linkLabel="View active carriers"
        />
        <KpiCard
          label="Packs Below Reserve"
          value={lowBatteryAlerts}
          tone={lowBatteryAlerts > 0 ? "danger" : "ok"}
          href="/digital-twin/battery-tracking"
          linkLabel="Review battery alerts"
        />
      </div>

      <Card>
        <CardHeader
          title="Arrivals"
          actions={<Pill tone="neutral">{inbound.length} incoming</Pill>}
        />
        <Hairline />
        {inbound.length > 0 && (
          <div className="scroll-thin max-h-[260px] overflow-auto">
            <table className="w-full min-w-[620px] border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-surface-2/95 backdrop-blur">
                <tr className="border-b border-line">
                  <th scope="col" className="px-5 py-2 text-[11px] font-semibold text-ink-3">Carrier ID</th>
                  <th scope="col" className="px-3 py-2 text-[11px] font-semibold text-ink-3">Origin</th>
                  <th scope="col" className="px-3 py-2 text-right text-[11px] font-semibold text-ink-3">Estimated arrival (ETA)</th>
                  <th scope="col" className="px-5 py-2 text-right text-[11px] font-semibold text-ink-3">Current SOC</th>
                </tr>
              </thead>
              <tbody>
                {inbound.slice(0, 4).map((truck) => (
                  <tr key={truck.vehicleId} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td className="px-5 py-2.5">
                      <Link
                        href={`/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(truck.vehicleId)}`}
                        className="num rounded-md text-[12px] font-semibold text-accent underline-offset-2 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                      >
                        {truck.carrierLabel}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-ink-2">{truck.origin}</td>
                    <td className="px-3 py-2.5 text-right">
                      <Pill tone="info">{formatEta(truck.etaMinutes) ?? "Unavailable"}</Pill>
                    </td>
                    <td className="num px-5 py-2.5 text-right text-[12px] font-semibold text-ink">
                      {truck.soc === null ? "Unavailable" : `${truck.soc}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Aggregate triage remains last; detailed panels stay on both source pages. */}
      <PanelErrorBoundary name="Combined operational alerts" resetKey={data.generated_at}>
        <AttentionPanel
          alerts={combinedAlerts}
          title="Need Attention — Batteries and Trucks"
          emptyMessage="No battery or carrier anomalies are open in the selected site scope."
          onAlertClick={openAlert}
          showScope
        />
      </PanelErrorBoundary>
    </div>
  );
}
