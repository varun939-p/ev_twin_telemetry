"use client";

import Link from "next/link";

import Modal from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import { predictArrival, formatEta } from "@/lib/fleet";
import {
  FIELD_GROUPS,
  STATUS_COPY,
  formatValue,
  type FieldStatus,
  type ParameterHealth,
  type TrustedVehicle,
} from "@/lib/trusted-telemetry";

/**
 * [Know More] pop-up — the full 24-parameter payload for one asset.
 *
 * This is where the table's density budget is spent: the row shows 6 vital
 * fields, everything else lives here.  The payload is rendered EXACTLY as the
 * data layer produced it —
 *
 *   * all 24 keys, in `FIELD_GROUPS` order (every parameter appears once,
 *     which is asserted by the group definition itself)
 *   * per-field verdicts (`measured` / `absent_upstream` / `null_upstream` /
 *     `field_error`) rendered as chips, so an unavailable channel is visibly
 *     unavailable rather than silently blank
 *   * nothing is coerced: a null stays a dash, and the reason is in the chip
 *
 * The 24-key contract is therefore surfaced, not mutated.
 */

const STATUS_TONE: Record<FieldStatus, "ok" | "warn" | "danger" | "neutral"> = {
  measured: "ok",
  absent_upstream: "neutral",
  null_upstream: "warn",
  field_error: "danger",
};

export default function TruckDetailModal({
  vehicle,
  params,
  batteryLabel,
  open,
  onClose,
}: {
  vehicle: TrustedVehicle | null;
  /** Label + unit metadata for all 24 parameters, from `orderedParams(doc)`. */
  params: ParameterHealth[];
  batteryLabel: string | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!vehicle) return null;

  const meta = new Map(params.map((p) => [p.field, p]));
  const arrival = predictArrival(vehicle);

  const observed = vehicle.observed_at
    ? new Date(vehicle.observed_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })
    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<span className="num">{vehicle.vehicle_id}</span>}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span>
            {vehicle.measured_count} of 24 parameters measured · {vehicle.completeness_pct}% complete
          </span>
          {batteryLabel && (
            <Link
              href={`/digital-twin/battery-tracking?battery_id=${encodeURIComponent(vehicle.vehicle_id)}`}
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              {batteryLabel} →
            </Link>
          )}
        </span>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-3">
          <span>
            Frame observed {observed ?? "—"} IST · signature{" "}
            <span className="num">{vehicle.signature.slice(0, 12)}…</span>
          </span>
          <span>
            Predicted arrival: {arrival.station?.name ?? "—"}
            {arrival.etaMinutes !== null && ` · ${formatEta(arrival.etaMinutes)}`}
            {arrival.distanceKm !== null && ` · ${arrival.distanceKm} km`}
          </span>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
        {FIELD_GROUPS.map((group) => (
          <section key={group.id} className="rounded-lg border border-line bg-surface-2 p-3">
            <h3 className="text-[11px] font-semibold text-ink-3">{group.title}</h3>
            <dl className="mt-2 space-y-1.5">
              {group.fields.map((field) => {
                const info = meta.get(field);
                const status = (vehicle.field_status[field] ?? "absent_upstream") as FieldStatus;
                const raw = vehicle.values[field] ?? null;
                const text = formatValue(raw, info?.unit ?? "");
                const error = vehicle.field_errors.find((e) => e.field === field);

                return (
                  <div
                    key={field}
                    className="flex items-baseline justify-between gap-3 rounded-md px-1.5 py-1 odd:bg-surface/60"
                  >
                    {/* Labels WRAP rather than truncate. "Battery Total
                        Voltage" clipped to "Battery Total Volt…" in a panel
                        whose whole job is to name all 24 channels precisely —
                        the raw key underneath is the disambiguator and must
                        stay whole too. */}
                    <dt className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium leading-snug text-ink">
                        {info?.label ?? field}
                      </span>
                      <span className="num mt-0.5 block break-all text-[10px] leading-tight text-ink-3">{field}</span>
                    </dt>
                    <dd className="shrink-0 text-right">
                      {status === "measured" && text !== null ? (
                        <span className="num text-[13px] font-semibold text-ink">{text}</span>
                      ) : (
                        <Pill
                          tone={STATUS_TONE[status]}
                          title={error ? `${STATUS_COPY[status].detail} — ${error.error}` : STATUS_COPY[status].detail}
                        >
                          {STATUS_COPY[status].short}
                        </Pill>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </div>

    </Modal>
  );
}
