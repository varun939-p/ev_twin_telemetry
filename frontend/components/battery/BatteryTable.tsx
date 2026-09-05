"use client";

import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import DetailChevron from "@/components/ui/DetailChevron";
import { StatusPill, Value } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/Surface";
import { SOC_CRITICAL, type BatteryRow } from "@/lib/fleet-metrics";
import { useIsHovered, useIsSelected, useTwin } from "@/lib/store";

/**
 * Battery register.
 *
 * Same density budget as the carrier table (six vital fields) and the same
 * pointer channel: rows subscribe to `useIsHovered(id)` individually, so
 * hovering an alert in the banner above highlights and scrolls to the matching
 * pack here without re-rendering the table.
 *
 * Cross-entity link: `Carrier / Truck ID` routes to
 * `/digital-twin/truck-telemetry?vehicle_id=<id>`, where the map flies to that
 * truck at a readable zoom and the row opens.
 *
 * Critically unhealthy packs (SOC < 20%) are tinted red at row level — the
 * spec's "highlight in Red" — not just badged, so they are findable while
 * scrolling a hundred rows.
 */

const Row = memo(function Row({ row, onKnowMore }: { row: BatteryRow; onKnowMore: (row: BatteryRow) => void }) {
  const hovered = useIsHovered(row.vehicleId);
  const selected = useIsSelected(row.vehicleId);
  const hover = useTwin((s) => s.hover);
  const select = useTwin((s) => s.select);
  const ref = useRef<HTMLTableRowElement>(null);

  /**
   * Monotonic sequence of the pointer AIMED AT THIS ROW, or null.
   *
   * Keyed on `seq` rather than on origin so that re-selecting the same row
   * (arriving twice from the same alert) still registers as a new event.
   */
  const pointerSeq = useTwin((s) =>
    s.selected?.vehicleId === row.vehicleId
      ? s.selected.seq
      : s.hovered?.vehicleId === row.vehicleId
        ? s.hovered.seq
        : null,
  );

  /**
   * NO SCROLLING. An incoming pointer — a deep link, an alert-banner click, a
   * carrier arriving on the map — announces itself with a brief background
   * pulse on the row and nothing else.
   *
   * `scrollIntoView({block:"nearest"})` was hijacking the page: because the
   * table is not its own scroll container, "nearest" resolves up to the
   * document scroller, so the viewport lurched every time a pointer changed.
   * Yanking someone's screen while they are reading a different row is the
   * kind of thing that gets a dashboard closed. The operator decides where to
   * look; the UI's job is to make the row findable, not to force it on them.
   *
   * `pulseKey` is bumped per pointer arrival so re-selecting the SAME row
   * restarts the animation (React would otherwise diff the class as unchanged
   * and nothing would happen).
   */
  useEffect(() => {
    if (pointerSeq === null) return;
    const el = ref.current;
    if (!el) return;
    // Remove -> force reflow -> re-add. Without the reflow the browser
    // coalesces the class churn into no change and the animation never
    // replays for a repeat hit on the same row.
    el.classList.remove("row-pulse");
    void el.offsetWidth;
    el.classList.add("row-pulse");
  }, [pointerSeq]);

  const critical = row.soc !== null && row.soc < SOC_CRITICAL;
  const socTone = row.soc === null ? "bg-ink-3" : critical ? "bg-danger" : row.soc < 50 ? "bg-warn" : "bg-ok";

  return (
    <tr
      ref={ref}
      onMouseEnter={() => hover(row.vehicleId, "table")}
      onMouseLeave={() => hover(null)}
      onClick={() => select(row.vehicleId, "table")}
      className={`cursor-pointer border-b border-line transition-colors last:border-0 ${
        selected
          ? "bg-accent-soft"
          : hovered
            ? "bg-surface-3"
            : critical
              ? "bg-danger-soft/60 hover:bg-danger-soft"
              : "hover:bg-surface-2"
      }`}
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-6 w-[3px] shrink-0 rounded-full ${
              selected ? "bg-accent" : critical ? "bg-danger" : hovered ? "bg-accent/50" : "bg-transparent"
            }`}
            aria-hidden
          />
          <div className="min-w-0">
            <p className={`truncate text-[13px] font-semibold ${critical ? "text-danger" : "text-ink"}`}>
              {row.batteryId}
            </p>
            <p className="num truncate text-[11px] text-ink-3">
              {row.slot === null ? "slot —" : `slot ${row.slot}`} · {row.place?.name ?? "unmapped"}
            </p>
          </div>
        </div>
      </td>

      <td className="px-3 py-2">
        <Link
          href={`/digital-twin/truck-telemetry?vehicle_id=${encodeURIComponent(row.vehicleId)}`}
          onClick={(e) => e.stopPropagation()}
          className="num inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-accent underline-offset-2 transition hover:bg-accent-soft hover:underline"
          title={`Open carrier ${row.carrierId} on Truck Telemetry`}
        >
          {row.carrierId}
          <span aria-hidden>→</span>
        </Link>
      </td>

      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3" aria-hidden>
            <span className={`block h-full rounded-full ${socTone}`} style={{ width: `${row.soc ?? 0}%` }} />
          </span>
          <span className={`num w-10 text-right text-[13px] font-semibold ${critical ? "text-danger" : "text-ink"}`}>
            <Value value={row.soc} unit="%" reason="soc not measured on this frame." />
          </span>
        </div>
      </td>

      <td className="px-3 py-2 text-right">
        <Value value={row.soh} unit="%" className="text-[13px] text-ink" reason="soh not measured on this frame." />
      </td>

      <td className="px-3 py-2 text-right">
        <Value value={row.cycles} className="text-[13px] text-ink-2" reason="charge_cycles not measured on this frame." />
      </td>

      <td className="px-3 py-2">
        <StatusPill status={row.status} />
      </td>

      <td className="px-3 py-2 text-right">
        <span className="text-[12px] text-ink-2">{row.station?.name ?? "—"}</span>
        {row.station && <span className="num block text-[11px] text-ink-3">{row.station.distanceKm} km away</span>}
      </td>

      <td className="px-3 py-2 text-right">
        {/* Same 24-parameter modal the carrier table opens — one component,
            one contract. `stopPropagation` keeps the click off the row's own
            select handler, which would otherwise fire a pointer event and
            pulse the row underneath the modal. */}
        <DetailChevron onClick={() => onKnowMore(row)} label={row.batteryId} />
      </td>
    </tr>
  );
});

type SortKey = "battery" | "soc" | "soh" | "cycles";

export default function BatteryTable({
  rows,
  onKnowMore,
}: {
  rows: BatteryRow[];
  /** Opens the shared 24-parameter modal for this pack's frame. */
  onKnowMore: (row: BatteryRow) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "soc", dir: "asc" });

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const num = (v: number | null) => (v === null ? Number.POSITIVE_INFINITY * dir : v);
    return [...rows].sort((a, b) => {
      switch (sort.key) {
        case "soc":
          return (num(a.soc) - num(b.soc)) * dir;
        case "soh":
          return (num(a.soh) - num(b.soh)) * dir;
        case "cycles":
          return (num(a.cycles) - num(b.cycles)) * dir;
        default:
          return a.batteryId.localeCompare(b.batteryId, undefined, { numeric: true }) * dir;
      }
    });
  }, [rows, sort]);

  const header = (key: SortKey, label: string, align: "left" | "right" = "left") => (
    <th scope="col" className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => setSort((p) => ({ key, dir: p.key === key && p.dir === "asc" ? "desc" : "asc" }))}
        className={`inline-flex cursor-pointer items-center gap-1 text-[11px] font-semibold transition ${
          sort.key === key ? "text-accent" : "text-ink-3 hover:text-ink-2"
        }`}
      >
        {label}
        <span aria-hidden className={sort.key === key ? "opacity-100" : "opacity-0"}>
          {sort.dir === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );

  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="No packs match the current filters"
          hint="SOC brackets exclude packs whose charge level is not measured — widen the bracket to see them."
        />
      </div>
    );
  }

  return (
    <div className="scroll-thin table-scroll max-h-[460px] overflow-auto">
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-surface-2/95 backdrop-blur">
          <tr className="border-b border-line">
            {header("battery", "Battery")}
            <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold text-ink-3">
              Carrier / Truck ID
            </th>
            {header("soc", "SOC", "right")}
            {header("soh", "SOH", "right")}
            {header("cycles", "Cycles", "right")}
            <th scope="col" className="px-3 py-2 text-left text-[11px] font-semibold text-ink-3">
              Status
            </th>
            <th scope="col" className="px-3 py-2 text-right text-[11px] font-semibold text-ink-3">
              Nearest hub
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
