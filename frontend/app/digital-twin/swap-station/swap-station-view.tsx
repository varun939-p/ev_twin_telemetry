"use client";

/**
 * Swap Station — DRAFT scaffold (3:00 PM review scope).
 *
 * Scaffolded, not built out:
 *   * 4 physical bays with status (charging with live %, vacant, 100% charged)
 *   * expected truck ETA countdowns
 *   * regional truck density radar at 10 / 50 / 100 km
 *   * Median Frame Age — moved here off Battery Tracking, where it never
 *     belonged: it is a pipeline-health metric about the ingest loop, not a
 *     property of a battery
 *
 * Honest split, same as everywhere else: the RADAR and the ETA COUNTDOWNS are
 * real (haversine over measured GPS fixes); the BAY STATES are the facility
 * model, badged accordingly.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import DraftNotice from "@/components/ui/DraftNotice";
import { KpiCard, Metric } from "@/components/ui/Metric";
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
  vehicleGeo,
} from "@/lib/fleet";
import { assetStatus, medianFrameAgeHours } from "@/lib/fleet-metrics";
import { simulateSite, type InboundSeed, type PackSeed } from "@/lib/site-model";
import { formatAge, haversineKm, numericValue, type TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

const RADII = [10, 50, 100] as const;

export default function SwapStationView({ data }: { data: TrustedTelemetryDocument }) {
  const [stationId, setStationId] = useState(SWAP_STATIONS[0].id);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const station = SWAP_STATIONS.find((s) => s.id === stationId) ?? SWAP_STATIONS[0];
  const vehicles = data.vehicles;
  const registry = useMemo(() => batteryRegistry(vehicles), [vehicles]);

  const packs = useMemo<PackSeed[]>(
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

  const site = useMemo(() => simulateSite(tick, packs, inbound, station), [tick, packs, inbound, station]);

  /** REAL density radar — haversine over measured fixes, no modelling. */
  const density = useMemo(() => {
    const counts = RADII.map(() => 0);
    for (const v of vehicles) {
      const geo = vehicleGeo(v);
      if (!geo) continue;
      const km = haversineKm(geo.lat, geo.lon, station.lat, station.lon);
      RADII.forEach((r, i) => {
        if (km <= r) counts[i] += 1;
      });
    }
    return counts;
  }, [vehicles, station]);

  const medianAge = useMemo(() => medianFrameAgeHours(vehicles), [vehicles]);

  const bayTone = (status: string) =>
    status === "full" ? "ok" : status === "vacant" ? "neutral" : status === "dispatching" ? "info" : "accent";

  return (
    <div className="space-y-4">
      <PageHeading
        title="Swap Station"
        subtitle="Bay-level telemetry, arrival queue and catchment density for one hub."
        actions={
          <SegmentedControl
            label="Site"
            value={stationId}
            onChange={setStationId}
            options={SWAP_STATIONS.map((s) => ({ value: s.id, label: s.name.replace(" Swap Hub", "") }))}
          />
        }
      />

      <DraftNotice
        scope="Swap Station — bay board, ETA countdowns and catchment radar scaffolded for review."
        needs={["bay_occupancy", "bay_charge_kw", "crane_state", "site_id on each frame"]}
      />

      {/* KPI strip ------------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Bays online" value={`${site.bays.filter((b) => b.status !== "vacant").length} / ${site.bays.length}`} tone="accent" hint="Occupied bays at this hub" />
        <KpiCard label="Packs at 100%" value={site.bays.filter((b) => b.status === "full").length} tone="ok" hint="Ready to dispatch on the next dock" />
        <KpiCard label="Carriers inbound" value={inbound.length} tone="info" hint={inbound[0] ? `Next in ${formatEta(inbound[0].etaMinutes)}` : "Queue empty"} />
        {/* Median Frame Age lives HERE, not on Battery Tracking. */}
        <KpiCard
          label="Median Frame Age"
          value={medianAge === null ? null : formatAge(medianAge)}
          tone={medianAge !== null && medianAge > 24 ? "warn" : "neutral"}
          hint="Ingest-loop health across the whole fleet — the freshness of the median asset's last validated frame."
          unavailableReason="No frame carries an observation timestamp."
        />
      </div>

      {/* Bay board ------------------------------------------------------ */}
      <Card>
        <CardHeader
          eyebrow="Bay board"
          title={`${station.name} — ${site.bays.length} physical bays`}
          description="Charging bays show live charge percentage and power draw; vacant bays are held for the next inbound pack."
          actions={<ModelBadge />}
        />
        <Hairline />
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {site.bays.map((bay) => (
            <div key={bay.id} className="rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3">Bay {bay.index}</p>
                <Pill tone={bayTone(bay.status)} dot pulse={bay.status === "charging"}>
                  {bay.status === "full" ? "100% charged" : bay.status}
                </Pill>
              </div>

              <p className="num mt-2 text-2xl font-semibold text-ink">
                {bay.soc === null ? "—" : `${bay.soc}%`}
              </p>

              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    bay.status === "full" ? "bg-ok" : bay.status === "vacant" ? "bg-ink-3" : "bg-accent"
                  }`}
                  style={{ width: `${bay.soc ?? 0}%` }}
                />
              </div>

              <dl className="mt-2.5 space-y-1 text-[11px]">
                <div className="flex justify-between">
                  <dt className="text-ink-3">Pack</dt>
                  <dd className="text-ink">{bay.batteryLabel ?? "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-3">Draw</dt>
                  <dd className="num text-ink">{bay.kw > 0 ? `${bay.kw} kW` : "—"}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-3">To full</dt>
                  <dd className="num text-ink">{bay.minutesToFull === null ? "—" : `${bay.minutesToFull} min`}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ETA countdowns ------------------------------------------------ */}
        <Card>
          <CardHeader
            eyebrow="Arrival queue"
            title="Expected truck ETA"
            description="Distance from each carrier's measured GPS fix at the fleet cruise assumption — the countdown ticks against the live clock."
          />
          <Hairline />
          {inbound.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-ink-3">No carriers currently moving toward this hub.</p>
          ) : (
            <ul className="scroll-thin max-h-[300px] divide-y divide-line overflow-y-auto">
              {inbound.slice(0, 10).map((truck, i) => {
                // Countdown = the GPS-derived ETA minus wall time since mount.
                const remaining = truck.etaMinutes === null ? null : Math.max(0, truck.etaMinutes - Math.floor(tick / 60));
                return (
                  <li key={truck.vehicleId}>
                    <Link
                      href={`/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(truck.vehicleId)}`}
                      className="flex items-center gap-3 px-5 py-2.5 transition hover:bg-surface-2"
                    >
                      <span className="num w-5 text-[10px] text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                      <span className="num min-w-0 flex-1 truncate text-xs font-medium text-ink">{truck.carrierLabel}</span>
                      <span className="num text-[11px] text-ink-3">{truck.distanceKm ?? "—"} km</span>
                      <Pill tone={remaining !== null && remaining < 30 ? "accent" : "neutral"} dot={remaining !== null && remaining < 30}>
                        {remaining === null ? "ETA —" : formatEta(remaining)}
                      </Pill>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Density radar -------------------------------------------------- */}
        <Card>
          <CardHeader
            eyebrow="Catchment"
            title="Regional truck density"
            description="Live count of carriers whose measured fix falls inside each radius of this hub."
          />
          <Hairline />
          <div className="grid grid-cols-1 items-center gap-4 p-4 sm:grid-cols-2">
            <svg viewBox="0 0 220 220" className="mx-auto h-[200px] w-[200px]" role="img" aria-label="Truck density radar">
              {[100, 68, 36].map((r, i) => (
                <circle
                  key={r}
                  cx={110}
                  cy={110}
                  r={r}
                  fill="var(--accent)"
                  fillOpacity={0.05 + i * 0.03}
                  stroke="var(--line-strong)"
                  strokeDasharray="3 4"
                />
              ))}
              <line x1={110} y1={6} x2={110} y2={214} stroke="var(--line)" />
              <line x1={6} y1={110} x2={214} y2={110} stroke="var(--line)" />
              {RADII.map((radius, i) => {
                const r = [36, 68, 100][i];
                return (
                  <text key={radius} x={112} y={110 - r + 12} className="fill-[var(--ink-3)]" style={{ fontSize: 9 }}>
                    {radius} km
                  </text>
                );
              })}
              <circle cx={110} cy={110} r={6} fill="var(--accent)" className="pulse-soft" />
              {/* Real fixes, projected radially by distance — a density read,
                  not a coordinate claim; the true map lives on Truck Telemetry. */}
              {vehicles.slice(0, 120).map((v, i) => {
                const geo = vehicleGeo(v);
                if (!geo) return null;
                const km = haversineKm(geo.lat, geo.lon, station.lat, station.lon);
                if (km > 100) return null;
                const rr = (km / 100) * 100;
                const angle = (i * 37) % 360;
                const x = 110 + rr * Math.cos((angle * Math.PI) / 180);
                const y = 110 + rr * Math.sin((angle * Math.PI) / 180);
                return <circle key={v.vehicle_id} cx={x} cy={y} r={2.5} fill="var(--info)" fillOpacity={0.8} />;
              })}
            </svg>

            <div className="space-y-2">
              {RADII.map((radius, i) => (
                <Metric key={radius} label={`Within ${radius} km`} value={density[i]} unit=" carriers" tone={i === 0 ? "accent" : "neutral"} />
              ))}
              <p className="text-[10px] leading-relaxed text-ink-3">
                Counts are exact (haversine over measured fixes). Dot placement inside the rings is by distance only —
                bearing is not drawn, because a radar sweep would imply a heading channel the feed does not publish.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
