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
import { useMemo, useState } from "react";

import SiteCanvas from "@/components/central/SiteCanvas";
import { KpiCard } from "@/components/ui/Metric";
import { ModelBadge, Pill } from "@/components/ui/Pill";
import { Card, CardHeader, Hairline, PageHeading } from "@/components/ui/Surface";
import { SegmentedControl } from "@/components/ui/Field";
import {
  SWAP_STATIONS,
  batteryRegistry,
  formatEta,
  isEvVehicle,
  nearestStation,
  predictArrival,
  truckChassis,
} from "@/lib/fleet";
import { SOC_CRITICAL, assetStatus, medianFrameAgeHours } from "@/lib/fleet-metrics";
import type { InboundSeed, PackSeed } from "@/lib/site-model";
import { numericValue, type TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

const DRILL_DOWNS = [
  { href: "/digital-twin/truck-telemetry", label: "Truck Telemetry", hint: "Carrier map, alerts, 24-param detail" },
  { href: "/digital-twin/battery-tracking", label: "Battery Tracking", hint: "Pack register, SOH, live SOC" },
];

export default function CentralView({ data }: { data: TrustedTelemetryDocument }) {
  const [stationId, setStationId] = useState<string>(SWAP_STATIONS[0].id);
  const station = SWAP_STATIONS.find((s) => s.id === stationId) ?? null;

  const vehicles = data.vehicles;
  const registry = useMemo(() => batteryRegistry(vehicles), [vehicles]);

  const medianAgeHours = useMemo(() => medianFrameAgeHours(vehicles), [vehicles]);

  /** Packs whose nearest hub is the selected site — real identities + SOC. */
  const sitePacks = useMemo<PackSeed[]>(
    () =>
      vehicles
        .filter((v) => isEvVehicle(v) && nearestStation(v)?.id === stationId)
        .map((v) => ({
          vehicleId: v.vehicle_id,
          batteryLabel: registry.get(v.vehicle_id)?.label ?? v.vehicle_id,
          soc: numericValue(v, "soc"),
        }))
        .sort((a, b) => (a.soc ?? 101) - (b.soc ?? 101)),
    [vehicles, stationId, registry],
  );

  /** Carriers actually moving toward this hub, ordered by GPS-derived ETA. */
  const inbound = useMemo<InboundSeed[]>(
    () =>
      vehicles
        .filter((v) => assetStatus(v) === "moving" && nearestStation(v)?.id === stationId)
        .map((v) => {
          const arrival = predictArrival(v);
          return {
            vehicleId: v.vehicle_id,
            carrierLabel: truckChassis(v.vehicle_id),
            distanceKm: arrival.distanceKm,
            etaMinutes: arrival.etaMinutes,
            soc: numericValue(v, "soc"),
          };
        })
        .sort((a, b) => (a.etaMinutes ?? 1e9) - (b.etaMinutes ?? 1e9)),
    [vehicles, stationId],
  );

  const inService = useMemo(() => vehicles.filter((v) => assetStatus(v) === "moving").length, [vehicles]);
  const belowReserve = useMemo(
    () => vehicles.filter((v) => isEvVehicle(v) && (numericValue(v, "soc") ?? 100) < SOC_CRITICAL).length,
    [vehicles],
  );

  return (
    <div className="space-y-4">
      <PageHeading
        title="Central Dashboard"
        subtitle="One site, end to end — road, swap station, chargers and backup generation, wired to the live fleet."
        actions={
          <SegmentedControl
            label="Site"
            value={stationId}
            onChange={setStationId}
            options={SWAP_STATIONS.map((s) => ({ value: s.id, label: s.name.replace(" Swap Hub", ""), count: sitePacksCount(vehicles, s.id) }))}
          />
        }
      />

      {/* 1 — live strip, all validated telemetry ------------------------- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          label="Carriers inbound to this hub"
          value={inbound.length}
          tone="accent"
          hint={
            inbound[0]?.etaMinutes != null
              ? `Next arrival ${formatEta(inbound[0].etaMinutes)} · ${inbound[0].distanceKm} km out`
              : "No moving carriers currently assigned to this hub"
          }
        />
        <KpiCard
          label="Packs assigned to this site"
          value={sitePacks.length}
          tone="neutral"
          hint="Nearest-hub assignment from each pack's measured GPS fix"
        />
        <KpiCard
          label="Fleet in service"
          value={inService}
          tone="ok"
          hint={`${inService} carriers reporting speed > 0 across every hub`}
        />
        <KpiCard
          label="Packs below reserve"
          value={belowReserve}
          tone={belowReserve > 0 ? "danger" : "ok"}
          hint={`Under the ${SOC_CRITICAL}% dispatch reserve, fleet-wide`}
        />
        {/* Median Frame Age was homed on the Swap Station draft. That route is
            gone, but the metric is the single best read on ingest-loop health,
            so it lands here on the fleet-wide overview rather than being lost
            with the page that used to host it. */}
        <KpiCard
          label="Median Frame Age"
          value={medianAgeHours === null ? null : Number(medianAgeHours.toFixed(1))}
          unit=" h"
          tone={medianAgeHours !== null && medianAgeHours > 24 ? "warn" : "ok"}
          hint="Freshness of the median asset's last validated frame — ingest-loop health"
          unavailableReason="No frame carries an observation timestamp in this document."
        />
      </div>

      {/* 2 — the site canvas -------------------------------------------- */}
      <Card>
        <CardHeader
          eyebrow="Live site canvas"
          title={`${station?.name ?? "Facility"} — interactive twin`}
          description="Click any asset to open its telemetry page. Energy flow lines animate with the modelled load; bays glow green as wattage flows, and a carrier docks whenever a swap transaction is active."
          actions={<ModelBadge />}
        />
        <Hairline />
        <div className="p-2 sm:p-3">
          <SiteCanvas packs={sitePacks} inbound={inbound} station={station} />
        </div>
        <div className="border-t border-line bg-surface-2 px-4 py-2.5">
          <p className="text-[12px] leading-relaxed text-ink-2">
            <span className="font-semibold text-ink">Provenance:</span> bay occupants, their SOC floor and every
            inbound ETA come from validated vehicle telemetry. Charge progression, gun power, crane motion and DG
            state come from <span className="num">lib/site-model.ts</span> — the vehicle feed publishes no facility
            channels. Point that module at a site controller and this canvas becomes fully live without a UI change.
          </p>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* 3 — inbound queue -------------------------------------------- */}
        <Card className="xl:col-span-2">
          <CardHeader
            eyebrow="Arrivals"
            title="Inbound carriers"
            description="Ordered by estimated arrival — distance from the measured fix at the fleet cruise assumption."
            actions={<Pill tone="neutral">{inbound.length} moving</Pill>}
          />
          <Hairline />
          {inbound.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-ink-3">
              No carriers are currently moving toward this hub.
            </p>
          ) : (
            <ul className="scroll-thin max-h-[260px] divide-y divide-line overflow-y-auto">
              {inbound.slice(0, 12).map((truck) => (
                <li key={truck.vehicleId}>
                  <Link
                    href={`/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(truck.vehicleId)}`}
                    className="flex items-center gap-3 px-5 py-2.5 transition hover:bg-surface-2"
                  >
                    <span className="num min-w-0 flex-1 truncate text-xs font-medium text-ink">{truck.carrierLabel}</span>
                    <span className="num text-[12px] text-ink-2">
                      {truck.soc === null ? "SOC —" : `SOC ${truck.soc}%`}
                    </span>
                    <span className="num text-[12px] text-ink-3">{truck.distanceKm ?? "—"} km</span>
                    <Pill tone="accent">{formatEta(truck.etaMinutes) ?? "ETA —"}</Pill>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 4 — drill-down rail ------------------------------------------ */}
        <Card>
          <CardHeader eyebrow="Navigate" title="Asset telemetry" description="Same targets the canvas routes to." />
          <Hairline />
          <ul className="divide-y divide-line">
            {DRILL_DOWNS.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="flex items-center gap-3 px-5 py-2.5 transition hover:bg-surface-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink">{item.label}</span>
                    <span className="block truncate text-[11px] text-ink-3">{item.hint}</span>
                  </span>
                  <span aria-hidden className="text-accent">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

/** Pack count per hub, for the site selector badges. */
function sitePacksCount(vehicles: TrustedTelemetryDocument["vehicles"], stationId: string): number {
  return vehicles.filter((v) => isEvVehicle(v) && nearestStation(v)?.id === stationId).length;
}
