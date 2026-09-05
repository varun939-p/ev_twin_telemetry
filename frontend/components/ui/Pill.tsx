import type { ReactNode } from "react";

import type { AssetStatus } from "@/lib/fleet-metrics";
import { STATUS_SHORT } from "@/lib/fleet-metrics";

/**
 * Status + labelling atoms.
 *
 * Tone is a semantic token ("ok" / "warn" / "danger" / "accent" / "info" /
 * "neutral"), never a raw colour, so light and dark stay in lockstep and a
 * status can only ever mean one thing across the map, the tables and the
 * site canvas.
 */

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-line bg-surface-2 text-ink-2",
  accent: "border-accent/30 bg-accent-soft text-accent",
  ok: "border-ok/30 bg-ok-soft text-ok",
  warn: "border-warn/30 bg-warn-soft text-warn",
  danger: "border-danger/35 bg-danger-soft text-danger",
  info: "border-info/30 bg-info-soft text-info",
};

const DOT_CLASS: Record<Tone, string> = {
  neutral: "bg-ink-3",
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
};

export function Pill({
  children,
  tone = "neutral",
  dot = false,
  pulse = false,
  className = "",
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-[3px] text-[11px] font-semibold ${TONE_CLASS[tone]} ${className}`}
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[tone]} ${pulse ? "pulse-soft" : ""}`} />}
      {children}
    </span>
  );
}

/**
 * Status hues, matched 1:1 to the map's marker colours so a green dot in the
 * table and a green pin on the map are the same fact.
 *
 * `charging` is INFO (steel indigo), not accent: copper is reserved for the
 * active nav item and primary CTAs. If a routine fleet state also wore the
 * accent, the accent would stop meaning "this is where you act".
 */
const STATUS_TONE: Record<AssetStatus, Tone> = {
  moving: "ok",
  charging: "info",
  idle: "warn",
  unknown: "neutral",
};

export function StatusPill({ status, className = "" }: { status: AssetStatus; className?: string }) {
  return (
    <Pill tone={STATUS_TONE[status]} dot pulse={status === "moving" || status === "charging"} className={className}>
      {STATUS_SHORT[status]}
    </Pill>
  );
}

/**
 * The single honest "no reading" atom.
 *
 * Every place a parameter can be null renders this instead of a 0.  It is
 * visually recessive AND carries the reason in its title attribute, so the
 * demo can be interrogated ("why is that blank?") without opening devtools.
 */
export function NoReading({ reason = "Not measured upstream — stored NULL by the data layer, not zero." }: { reason?: string }) {
  return (
    <span className="num cursor-help text-ink-3" title={reason}>
      —
    </span>
  );
}

/** A metric value that may be null. Keeps unit styling consistent everywhere. */
export function Value({
  value,
  unit,
  className = "",
  reason,
}: {
  value: string | number | null | undefined;
  unit?: string;
  className?: string;
  reason?: string;
}) {
  if (value === null || value === undefined || value === "") return <NoReading reason={reason} />;
  return (
    <span className={`num ${className}`}>
      {value}
      {unit && <span className="ml-0.5 text-[0.75em] font-normal text-ink-3">{unit}</span>}
    </span>
  );
}

/** Marks any surface driven by `lib/site-model` rather than validated telemetry. */
export function ModelBadge({ className = "" }: { className?: string }) {
  return (
    <Pill tone="info" className={className} title="Rendered from the facility model in lib/site-model.ts — the vehicle feed carries no facility telemetry. Swap for a live site-controller feed without touching this UI.">
      Facility model
    </Pill>
  );
}

