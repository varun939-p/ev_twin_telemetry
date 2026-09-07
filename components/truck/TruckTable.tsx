"use client";

import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { StatusPill, Value } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/Surface";
import DetailChevron from "@/components/ui/DetailChevron";
import { scrollMapIntoView } from "@/lib/focus";
import { ZOOM } from "@/lib/map-data";
import { useIsHovered, useIsSelected, useTwin } from "@/lib/store";
import type { TruckRow } from "@/lib/fleet-metrics";

/**
 * Carrier table — 6 vital fields per row, everything else behind [Know More].
 *
 * DENSITY BUDGET
 *   Carrier · Status · SOC · Residual range · Odometer · Battery
 * The old build put 12 columns of mixed-provenance numbers on screen at once.
 * These six are the ones an operator scans; the other eighteen parameters are
 * one click away in the modal, which is also the only place the full 24-key
 * payload is rendered.
 *
 * HOVER SYNCHRONISATION (the critical bit)
 *   * `<Row>` is memoised and subscribes to `useIsHovered(id)` — a boolean.
 *     Moving the pointer across the map re-renders the two rows whose boolean
 *     flipped, not the table.
 *   * When the hover ORIGINATES on the map, the table scrolls that row into
 *     view inside its own scroll container (never the window), so the page
 *     does not jump under the operator's cursor.
 *   * Row hover publishes with origin "table", which the map reads to grow and
 *     label the matching pin. Neither side listens to its own events, so the
 *     link cannot feed back on itself.
 */

type SortKey = "id" | "soc" | "residual" | "odometer" | "status";
type SortDir = "asc" | "desc";

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = "left",
  className = "",
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th scope="col" className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex cursor-pointer items-center gap-1 text-[11px] font-semibold transition ${
          active ? "text-accent" : "text-ink-3 hover:text-ink-2"
        }`}
      >
        {label}
        <span aria-hidden className={active ? "opacity-100" : "opacity-0"}>
          {dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

const Row = memo(function Row({
  row,
  onKnowMore,
}: {
  row: TruckRow;
  onKnowMore: (row: TruckRow) => void;
}) {
  const hovered = useIsHovered(row.vehicleId);
  const selected = useIsSelected(row.vehicleId);
  const hover = useTwin((s) => s.hover);
  const select = useTwin((s) => s.select);
  const requestFly = useTwin((s) => s.requestFly);
  const ref = useRef<HTMLTableRowElement>(null);

  /**
   * Map -> table: announce the row, never move the page.
   *
   * This used to call `scrollIntoView({block:"nearest"})`. The table is not
   * its own scroll container, so "nearest" resolves up to the document
   * scroller and the viewport lurched every time the pointer moved over a
   * map pin — hijacking the screen of someone reading a different row.
   * The row now pulses instead; the operator decides where to look.
   *
   * Keyed on `seq`, so re-hovering the SAME pin replays the pulse.
   */
  const pointerSeq = useTwin((s) =>
    s.selected?.vehicleId === row.vehicleId
      ? s.selected.seq
      : s.hovered?.vehicleId === row.vehicleId
        ? s.hovered.seq
        : null,
  );
  useEffect(() => {
    if (pointerSeq === null) return;
    const el = ref.current;
    if (!el) return;
    // remove -> reflow -> re-add, or the browser coalesces the class churn
    // into no change and the animation never replays.
    el.classList.remove("row-pulse");
    void el.offsetWidth;
    el.classList.add("row-pulse");
  }, [pointerSeq]);

  const openOnMap = () => {
    select(row.vehicleId, "table");
    // Focus contract: a fleet-row click brings the map into view before the
    // camera flies — the table sits below the fold, so the flight would
    // otherwise happen off-screen.
    scrollMapIntoView();
    const lat = row.vehicle.values["latitude"];
    const lon = row.vehicle.values["longitude"];
    if (typeof lat === "number" && typeof lon === "number") requestFly(lat, lon, ZOOM.asset);
  };

  const socTone = row.soc === null ? "bg-ink-3" : row.soc < 20 ? "bg-danger" : row.soc < 50 ? "bg-warn" : "bg-ok";

  return (
    <tr
      ref={ref}
      onMouseEnter={() => hover(row.vehicleId, "table")}
      onMouseLeave={() => hover(null)}
      onClick={openOnMap}
      className={`cursor-pointer border-b border-line transition-colors last:border-0 ${
        selected
          ? "bg-accent-soft"
          : hovered
            ? "bg-surface-3"
            : "hover:bg-surface-2"
      }`}
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-6 w-[3px] shrink-0 rounded-full transition-colors ${
              selected ? "bg-accent" : hovered ? "bg-accent/50" : "bg-transparent"
            }`}
            aria-hidden
          />
          <div className="min-w-0">
            <p className="num truncate text-[13px] font-semibold text-ink">{row.chassis}</p>
            <p className="truncate text-[11px] text-ink-3">
              {row.place ? `${row.place.name}, ${row.place.state}` : "No mapped location"}
            </p>
          </div>
        </div>
      </td>

      <td className="px-3 py-2">
        <StatusPill status={row.status} />
      </td>

      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <span className={`block h-full rounded-full ${socTone}`} style={{ width: `${row.soc ?? 0}%` }} />
          </span>
          <span className="num w-10 text-right text-[13px] font-semibold text-ink">
            <Value value={row.soc} unit="%" reason="soc is not measured on this frame." />
          </span>
        </div>
      </td>

      <td className="px-3 py-2 text-right">
        <Value value={row.residualKm} unit=" km" className="text-[13px] text-ink" reason="residual_mileage_km not measured on this frame." />
      </td>

      <td className="px-3 py-2 text-right">
        <Value
          value={row.odometerKm === null ? null : Math.round(row.odometerKm).toLocaleString("en-IN")}
          unit=" km"
          className="text-[13px] text-ink-2"
          reason="odometer_km not measured on this frame."
        />
      </td>

      <td className="px-3 py-2">
        {row.batteryLabel ? (
          // Cross-entity link. `stopPropagation` so following the link does not
          // also fire the row's "fly the map here" click handler.
          <Link
            href={`/digital-twin/battery-tracking?battery_id=${encodeURIComponent(row.vehicleId)}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-semibold text-accent underline-offset-2 transition hover:bg-accent-soft hover:underline"
            title={`Open ${row.batteryLabel} on Battery Tracking`}
          >
            {row.batteryLabel}
            <span aria-hidden>→</span>
          </Link>
        ) : (
          <span className="text-[12px] text-ink-3" title="No pack telemetry on this frame — carrier only.">
            Non-EV
          </span>
        )}
      </td>

      <td className="px-3 py-2 text-right">
        <DetailChevron onClick={() => onKnowMore(row)} label={row.chassis} />
      </td>
    </tr>
  );
});

export default function TruckTable({
  rows,
  onKnowMore,
}: {
  rows: TruckRow[];
  onKnowMore: (row: TruckRow) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "soc", dir: "asc" });

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    // Nulls always sink to the bottom regardless of direction: an unmeasured
    // value is not "the smallest", it is unknown.
    const compareNumbers = (a: number | null, b: number | null) => {
      // Unknown values always sink, regardless of direction.
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a - b) * dir;
    };
    return [...rows].sort((a, b) => {
      switch (sort.key) {
        case "soc":
          return compareNumbers(a.soc, b.soc);
        case "residual":
          return compareNumbers(a.residualKm, b.residualKm);
        case "odometer":
          return compareNumbers(a.odometerKm, b.odometerKm);
        case "status":
          return a.status.localeCompare(b.status) * dir;
        default:
          return a.chassis.localeCompare(b.chassis) * dir;
      }
    });
  }, [rows, sort]);

  const toggle = (key: SortKey) =>
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc" }));

  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="No carriers match the current filters"
          hint="Clear the region cascade or exit the map drill-down to widen the scope."
        />
      </div>
    );
  }

  return (
    <div className="scroll-thin table-scroll max-h-[520px] overflow-auto">
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-surface-2/95 backdrop-blur">
          <tr className="border-b border-line">
            <SortHeader label="Carrier" active={sort.key === "id"} dir={sort.dir} onClick={() => toggle("id")} />
            <SortHeader label="Status" active={sort.key === "status"} dir={sort.dir} onClick={() => toggle("status")} />
            <SortHeader label="SOC" align="right" active={sort.key === "soc"} dir={sort.dir} onClick={() => toggle("soc")} />
            <SortHeader label="Residual" align="right" active={sort.key === "residual"} dir={sort.dir} onClick={() => toggle("residual")} />
            <SortHeader label="Odometer" align="right" active={sort.key === "odometer"} dir={sort.dir} onClick={() => toggle("odometer")} />
            <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold text-ink-3">
              Battery
            </th>
            <th scope="col" className="px-3 py-2 text-right text-[11px] font-semibold text-ink-3">
              Detail
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <Row key={row.vehicleId} row={row} onKnowMore={onKnowMore} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
