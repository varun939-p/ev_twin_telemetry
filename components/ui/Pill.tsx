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

/**
 * Tinted ground + darker text of the SAME hue — never a solid saturated pill.
 *
 * The borders are gone deliberately. A tint plus a matching outline reads as a
 * filled button and competes with the real controls; the tint alone is enough
 * separation at this contrast, and it keeps a table of 100 status chips quiet.
 */
const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-neutral-soft text-neutral-ink",
  accent: "bg-accent-soft text-accent",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
};

const DOT_CLASS: Record<Tone, string> = {
  neutral: "bg-neutral-ink",
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
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-[3px] text-[12px] font-medium ${TONE_CLASS[tone]} ${className}`}
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
/**
 * Status hues, matched 1:1 to the map markers and the isometric bays.
 *
 * `idle` is NEUTRAL, not amber. A parked carrier is the normal resting state
 * of most of the fleet — 90 of 100 frames right now — and painting it as a
 * warning made the register look like an emergency and left no colour
 * headroom for the packs that genuinely need attention. Amber is reserved for
 * "approaching reserve".
 */
const STATUS_TONE: Record<AssetStatus, Tone> = {
  moving: "ok",
  charging: "ok",
  idle: "neutral",
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

