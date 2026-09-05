"use client";

/**
 * Truck Telemetry — the carrier lens.
 *
 * PAGE HIERARCHY (spec order, top to bottom)
 *   1. Geographic map, FULL WIDTH, at the absolute top
 *   2. Truck-scoped "Need Attention" alerts (moved off the old fleet page)
 *   3. Global filter bar — immediately above the table, never over the map
 *   4. Carrier table, 6 vital fields + [Know More]
 *   5. Unlocatable carriers (no GPS fix) — listed, never plotted at (0, 0)
 *
 * DATA FLOW
 *   document (server)
 *     -> batteryRegistry over the FULL fleet   (stable "Battery N" labels)
 *     -> applyVehicleFilters(store filters)    (the scope)
 *     -> truckRows()          -> table
 *     -> buildMapPoints()     -> map markers
 *     -> buildCityClusters()  -> map bubbles -> setGeo() -> back to the scope
 *   The map and the table are siblings reading one derived scope; neither
 *   owns the other, which is what keeps the hover link cycle-free.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import AttentionPanel from "@/components/alerts/AttentionPanel";
import FleetMap from "@/components/map/FleetMap";
import TruckDetailModal from "@/components/truck/TruckDetailModal";
import TruckFilterBar from "@/components/truck/TruckFilterBar";
import TruckTable from "@/components/truck/TruckTable";
import { Card, CardHeader, Hairline, PageHeading } from "@/components/ui/Surface";
import { Pill } from "@/components/ui/Pill";
import { applyVehicleFilters, batteryRegistry, isEvVehicle, stateCounts } from "@/lib/fleet";
import { truckAlerts, truckRows, type TruckRow } from "@/lib/fleet-metrics";
import { buildCityClusters, buildMapPoints, ZOOM } from "@/lib/map-data";
import { useFilterState, useTwin } from "@/lib/store";
import { orderedParams, type TrustedTelemetryDocument } from "@/lib/trusted-telemetry";

export default function TruckTelemetryView({ data }: { data: TrustedTelemetryDocument }) {
  const filters = useFilterState();
  const select = useTwin((s) => s.select);
  const requestFly = useTwin((s) => s.requestFly);
  const searchParams = useSearchParams();

  const [detail, setDetail] = useState<TruckRow | null>(null);

  /* --------------------------------------------------------- derivations */

  const vehicles = data.vehicles;
  const registry = useMemo(() => batteryRegistry(vehicles), [vehicles]);
  const params = useMemo(() => orderedParams(data), [data]);
  const counts = useMemo(() => stateCounts(vehicles), [vehicles]);
  const evCounts = useMemo(() => {
    const ev = vehicles.filter(isEvVehicle).length;
    return { ev, nonEv: vehicles.length - ev };
  }, [vehicles]);

  const scoped = useMemo(() => applyVehicleFilters(vehicles, filters), [vehicles, filters]);
  const rows = useMemo(() => truckRows(scoped, registry), [scoped, registry]);
  const alerts = useMemo(() => truckAlerts(scoped), [scoped]);

  const { points, unlocatable } = useMemo(() => buildMapPoints(rows), [rows]);
  const clusters = useMemo(() => buildCityClusters(points), [points]);

  const statusCounts = useMemo(() => {
    const c = { moving: 0, charging: 0, idle: 0, unknown: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  /* --------------------------------------------------------- deep links */

  /** `?vehicle_id=<id>` from Battery Tracking: select it and fly to it once. */
  const handledLink = useRef<string | null>(null);
  const deepLink = searchParams.get("vehicle_id");

  useEffect(() => {
    if (!deepLink || handledLink.current === deepLink) return;
    const match = vehicles.find(
      (v) => v.vehicle_id === deepLink || v.vehicle_id.replace(/_EV\d+$/i, "") === deepLink,
    );
    if (!match) return;
    handledLink.current = deepLink;
    select(match.vehicle_id, "link");
    const lat = match.values["latitude"];
    const lon = match.values["longitude"];
    if (typeof lat === "number" && typeof lon === "number") requestFly(lat, lon, ZOOM.asset);
    document.getElementById("carrier-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [deepLink, vehicles, select, requestFly]);

  /* ------------------------------------------------------------- render */

  return (
    <div className="space-y-4">
      <PageHeading
        title="Truck Telemetry"
        subtitle="Carriers on the live network — position, motion state and the pack each one is carrying."
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone="ok" dot pulse>
              {statusCounts.moving} moving
            </Pill>
            <Pill tone="accent" dot>
              {statusCounts.charging} charging
            </Pill>
            <Pill tone="warn" dot>
              {statusCounts.idle} idle
            </Pill>
            {statusCounts.unknown > 0 && <Pill tone="neutral">{statusCounts.unknown} no reading</Pill>}
          </div>
        }
      />

      {/* 1 — MAP, absolute top, full width ------------------------------- */}
      <Card>
        <CardHeader
          eyebrow="Live geography"
          title="Real-time carrier map"
          description="Every pin is a measured GPS fix coloured by live motion state. Hover a pin to highlight its row below; click a city cluster to filter the table to that state and city. Wheel, +/− and drag all zoom — no camera move goes past a readable radius."
          actions={
            <Pill tone="neutral" title="Zoom ceiling applied to every programmatic camera move">
              max drill-in z{ZOOM.asset}
            </Pill>
          }
        />
        <Hairline />
        <div className="p-3">
          <FleetMap points={points} clusters={clusters} heightClass="h-[440px]" />
          <p className="mt-2 px-1 text-[11px] text-ink-3">
            <span className="num">{points.length}</span> of <span className="num">{rows.length}</span> carriers in
            scope carry a measured fix
            {unlocatable.length > 0 && (
              <>
                {" "}
                · <span className="num">{unlocatable.length}</span> have no GPS channel and are listed below rather
                than plotted at (0, 0)
              </>
            )}
            .
          </p>
        </div>
      </Card>

      {/* 2 — truck-scoped alerts ---------------------------------------- */}
      <AttentionPanel
        alerts={alerts}
        title="Need Attention — Carriers"
        emptyMessage="No carrier anomalies in the current scope. Battery chemistry alerts live on Battery Tracking."
      />

      {/* 3 + 4 — filters directly above the table ------------------------ */}
      <div id="carrier-table" className="space-y-3">
        <TruckFilterBar
          stateCounts={counts}
          evCounts={evCounts}
          scopedCount={rows.length}
          totalCount={vehicles.length}
        />

        <Card>
          <CardHeader
            eyebrow="Deployment candidates"
            title="Carrier fleet"
            description="Six vital fields per row. The full 24-parameter payload for any carrier is one click away in [Know More]."
            actions={
              <span className="text-[11px] text-ink-3">
                Sorted rows keep unmeasured values at the bottom — a null is unknown, not zero.
              </span>
            }
          />
          <Hairline />
          <TruckTable rows={rows} onKnowMore={setDetail} />
        </Card>
      </div>

      {/* 5 — carriers with no fix ---------------------------------------- */}
      {unlocatable.length > 0 && (
        <Card padded>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-3">
            Unlocatable carriers ({unlocatable.length})
          </h3>
          <p className="mt-1 text-[11px] text-ink-2">
            latitude/longitude are not measured on these frames, so they cannot be plotted honestly.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {unlocatable.map((row) => (
              <li key={row.vehicleId}>
                <button
                  type="button"
                  onClick={() => setDetail(row)}
                  className="num cursor-pointer rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-ink-2 transition hover:border-accent/40 hover:text-accent"
                >
                  {row.chassis}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <TruckDetailModal
        open={detail !== null}
        vehicle={detail?.vehicle ?? null}
        params={params}
        batteryLabel={detail?.batteryLabel ?? null}
        onClose={() => setDetail(null)}
      />
    </div>
  );
}
