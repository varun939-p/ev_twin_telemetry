import Link from "next/link";
import type { ReactNode } from "react";

import { Pill, type Tone } from "@/components/ui/Pill";

/**
 * KPI tile.
 *
 * Two hard rules encoded here rather than left to each page:
 *
 *  1. `value === null` is a first-class state, not a fallback.  The tile
 *     renders an em-dash plus an "awaiting upstream" pill and the reason —
 *     it never prints 0 for a channel the fleet does not measure.
 *  2. When `href` is set the whole tile is a real <Link> (keyboard reachable,
 *     middle-clickable, prefetched) rather than a div with an onClick.
 */
export function KpiCard({
  label,
  value,
  unit,
  hint,
  href,
  tone = "neutral",
  unavailableReason,
  icon,
  footer,
}: {
  label: string;
  value: number | string | null;
  unit?: string;
  hint?: string;
  href?: string;
  tone?: Tone;
  /** Why the value is null; shown instead of the hint when it is. */
  unavailableReason?: string;
  icon?: ReactNode;
  footer?: ReactNode;
}) {
  const accentText: Record<Tone, string> = {
    neutral: "text-ink",
    accent: "text-accent",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
    info: "text-info",
  };

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold text-ink-3">{label}</p>
        {icon}
      </div>

      <p className={`display mt-2 text-[28px] font-bold leading-none tabular-nums ${value === null ? "text-ink-3" : accentText[tone]}`}>
        {value === null ? "—" : value}
        {unit && value !== null && <span className="ml-1 text-sm font-medium text-ink-3">{unit}</span>}
      </p>

      {value === null && unavailableReason ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Pill tone="warn" title={unavailableReason}>
            Awaiting upstream
          </Pill>
          <span className="text-[11px] leading-snug text-ink-3">{unavailableReason}</span>
        </div>
      ) : (
        hint && <p className="mt-1.5 text-[12px] leading-snug text-ink-2">{hint}</p>
      )}

      {footer && <div className="mt-2">{footer}</div>}
    </>
  );

  const shell =
    "block rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow)] transition";

  if (href) {
    return (
      <Link
        href={href}
        className={`${shell} group cursor-pointer hover:border-accent/50 hover:bg-accent-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
      >
        {body}
        <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent opacity-80 transition group-hover:opacity-100">
          Open swap station
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden>
            <path d="M3 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </Link>
    );
  }

  return <div className={shell}>{body}</div>;
}

/** Compact label/value pair used inside detail panels and drafts. */
export function Metric({
  label,
  value,
  unit,
  tone = "neutral",
  reason,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  tone?: Tone;
  reason?: string;
}) {
  const accentText: Record<Tone, string> = {
    neutral: "text-ink",
    accent: "text-accent",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
    info: "text-info",
  };
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <p className="text-[10px] font-semibold text-ink-3">{label}</p>
      <p
        className={`num mt-1 text-[15px] font-semibold ${value === null ? "cursor-help text-ink-3" : accentText[tone]}`}
        title={value === null ? (reason ?? "Not measured upstream — stored NULL, not zero.") : undefined}
      >
        {value === null ? "—" : value}
        {unit && value !== null && <span className="ml-0.5 text-[12px] font-normal text-ink-3">{unit}</span>}
      </p>
    </div>
  );
}
