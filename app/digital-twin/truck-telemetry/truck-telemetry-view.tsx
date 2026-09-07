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

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";

import AttentionPanel from "@/components/alerts/AttentionPanel";
import FleetMap from "@/components/map/FleetMap";
import TruckDetailModal from "@/components/truck/TruckDetailModal";
import TruckFilterBar from "@/components/truck/TruckFilterBar";
import TruckTable from "@/components/truck/TruckTable";
import { Card, CardHeader, Hairline, PageHeading } from "@/components/ui/Surface";
import PanelErrorBoundary from "@/components/ui/PanelErrorBoundary";
import { Pill } from "@/components/ui/Pill";
import { MAP_ANCHOR_ID, scrollMapIntoView, VEHICLE_DEEP_LINK_PARAM } from "@/lib/focus";
import { applyVehicleFilters, batteryRegistry, buildGeoIndex, deriveSites, isEvVehicle } from "@/lib/fleet";
import { truckAlerts, truckRows, type TruckRow } from "@/lib/fleet-metrics";
import { buildCityClusters, buildMapPoints, ZOOM } from "@/lib/map-data";
import { normalizeGpsCoordinates } from "@/lib/gps";
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
  // Built from the FULL fleet so options never disappear mid-drill-down.
  const geoIndex = useMemo(() => buildGeoIndex(vehicles), [vehicles]);
  const evCounts = useMemo(() => {
    const ev = vehicles.filter(isEvVehicle).length;
    return { ev, nonEv: vehicles.length - ev };
  }, [vehicles]);

  /** Operating sites derived from the payload — never a hardcoded hub list. */
  const sites = useMemo(() => deriveSites(vehicles), [vehicles]);

  const scoped = useMemo(() => applyVehicleFilters(vehicles, filters, sites), [vehicles, filters, sites]);
  const rows = useMemo(() => truckRows(scoped, registry), [scoped, registry]);
  const alerts = useMemo(() => truckAlerts(scoped, sites), [scoped, sites]);

  const { points, unlocatable } = useMemo(() => buildMapPoints(rows), [rows]);
  const clusters = useMemo(() => buildCityClusters(points), [points]);

  /**
   * Cross-component click-to-zoom: an alert-row click selects the carrier AND
   * flies the map to its live GPS position at the readable asset radius (the
   * table rows do the same via TruckTable.openOnMap). Trucks without a
   * measured fix are selected but cannot be flown to honestly.
   */
  const focusAlertOnMap = useCallback(
    (vehicleId: string) => {
      select(vehicleId, "table");
      scrollMapIntoView(); // the alert panel sits BELOW the map — go to it
      const pt = points.find((p) => p.vehicleId === vehicleId);
      if (pt) {
        requestFly(pt.lat, pt.lon, ZOOM.asset);
        return;
      }
      const row = rows.find((r) => r.vehicleId === vehicleId);
      const coordinate = normalizeGpsCoordinates(
        row?.vehicle.values["latitude"],
        row?.vehicle.values["longitude"],
      );
      if (coordinate) requestFly(coordinate.lat, coordinate.lon, ZOOM.asset);
    },
    [rows, points, select, requestFly],
  );

  const statusCounts = useMemo(() => {
    const c = { moving: 0, charging: 0, idle: 0, unknown: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  /* --------------------------------------------------------- deep links */

  /**
   * `?vehicle_id=<id>` deep links — the landing half of the cross-page focus
   * contract. Central Dashboard rows, Battery Tracking rows and battery
   * alerts all navigate here; the contract is: land on this page, AUTO-SCROLL
   * to the map, select the carrier and fly/zoom to its live GPS fix.
   *
   * A carrier whose frame carries no measured fix is selected and scrolled to
   * but never flown to — an invented coordinate would be a fabrication, so
   * the map stays at the fleet frame and the table row pulses instead.
   */
  const handledLink = useRef<string | null>(null);
  const deepLink = searchParams.get(VEHICLE_DEEP_LINK_PARAM);

  useEffect(() => {
    if (!deepLink || handledLink.current === deepLink) return;
    handledLink.current = deepLink;
    const match = vehicles.find(
      (v) => v.vehicle_id === deepLink || v.vehicle_id.replace(/_EV\d+$/i, "") === deepLink,
    );
    scrollMapIntoView();
    if (!match) return;
    select(match.vehicle_id, "link");
    const pt = points.find((p) => p.vehicleId === match.vehicle_id);
    if (pt) {
      requestFly(pt.lat, pt.lon, ZOOM.asset);
    } else {
      const coordinate = normalizeGpsCoordinates(match.values["latitude"], match.values["longitude"]);
      if (coordinate) requestFly(coordinate.lat, coordinate.lon, ZOOM.asset);
    }
  }, [deepLink, vehicles, points, select, requestFly]);

  /* ------------------------------------------------------------- render */

  return (
    <div className="space-y-4">
      <PageHeading
        title="Truck Telemetry"
        actions={
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Carrier status totals">
            <Pill tone="neutral">{rows.length} total carriers</Pill>
            <Pill tone="ok" dot pulse>
              {statusCounts.moving} moving
            </Pill>
            <Pill tone="info" dot>
              {statusCounts.charging} charging
            </Pill>
            <Pill tone="neutral" dot>
              {statusCounts.idle} parked
            </Pill>
            <Pill tone="warn" dot>
              {statusCounts.unknown} other / offline
            </Pill>
          </div>
        }
      />

      {/* 1 — MAP, absolute top, full width ------------------------------- */}
      <Card id={MAP_ANCHOR_ID} className="scroll-mt-16">
        <div className="p-3">
          <PanelErrorBoundary name="Carrier map" resetKey={data.generated_at}>
            <FleetMap points={points} clusters={clusters} heightClass="h-[440px]" />
          </PanelErrorBoundary>
          <p className="mt-2 px-1 text-[12px] text-ink-3">
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
      <PanelErrorBoundary name="Carrier alerts" resetKey={data.generated_at}>
        <AttentionPanel
          alerts={alerts}
          title="Need Attention — Carriers"
          emptyMessage="No carrier anomalies in the current scope. Battery chemistry alerts live on Battery Tracking."
          onRowClick={focusAlertOnMap}
        />
      </PanelErrorBoundary>

      {/* 3 + 4 — filters directly above the table ------------------------ */}
      <div id="carrier-table" className="space-y-3">
        <TruckFilterBar
          geoIndex={geoIndex}
          evCounts={evCounts}
          scopedCount={rows.length}
          totalCount={vehicles.length}
        />

        <Card>
          <CardHeader title="Carrier fleet" />
          <Hairline />
          <PanelErrorBoundary name="Carrier fleet table" resetKey={data.generated_at}>
            <TruckTable rows={rows} onKnowMore={setDetail} />
          </PanelErrorBoundary>
        </Card>
      </div>

      {/* 5 — carriers with no fix ---------------------------------------- */}
      {unlocatable.length > 0 && (
        <Card padded>
          <h3 className="text-[11px] font-semibold text-ink-3">
            Unlocatable carriers ({unlocatable.length})
          </h3>
          <p className="mt-1 text-[12px] text-ink-2">
            latitude/longitude are not measured on these frames, so they cannot be plotted honestly.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {unlocatable.map((row) => (
              <li key={row.vehicleId}>
                <button
                  type="button"
                  onClick={() => setDetail(row)}
                  className="num cursor-pointer rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-ink-2 transition hover:border-accent/40 hover:text-accent"
                >
                  {row.chassis}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <TruckDetailModal
        sites={sites}
        open={detail !== null}
        vehicle={detail?.vehicle ?? null}
        params={params}
        batteryLabel={detail?.batteryLabel ?? null}
        onClose={() => setDetail(null)}
      />
    </div>
  );
}
