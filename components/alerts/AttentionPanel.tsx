"use client";

import { useMemo, useState } from "react";

import InfoTip from "@/components/ui/InfoTip";
import { useSocTrend } from "@/lib/soc-history";
import { Pill, type Tone } from "@/components/ui/Pill";
import { useTwin } from "@/lib/store";
import { ALERT_KIND_LABEL, type AlertKind, type AlertSeverity, type TwinAlert } from "@/lib/fleet-metrics";

/**
 * "Need Attention" banner.
 *
 * One component, two mount points, isolated scopes:
 *   Truck Telemetry     -> `truckAlerts()`   (position, staleness, range)
 *   Battery Tracking    -> `batteryAlerts()` (SOC, SOH, rejected readings)
 * A battery anomaly can therefore never leak into the truck page and vice
 * versa — the split the spec asks for is enforced by the data source, not by
 * a filter the caller might forget.
 *
 * Interaction contract:
 *   * critical rows are red-tinted and sorted first
 *   * the (i) affordance opens a contextual comment on hover AND on focus
 *   * clicking a row publishes the asset selection, so the map flies to it
 *     and the table below scrolls it into view — the same pointer channel the
 *     hover sync uses
 *   * rows are GROUPED BY KIND and each group is capped: an operator triages
 *     "87 packs are stale" once, not 87 times. `PREVIEW_ROWS` of the worst
 *     offenders show immediately; the rest are one click away.
 */

/** Rows rendered per kind before the group collapses behind "Show all". */
const PREVIEW_ROWS = 2;

const SEVERITY_TONE: Record<AlertSeverity, Tone> = {
  critical: "danger",
  warning: "warn",
  info: "info",
};

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Notice",
};

export default function AttentionPanel({
  alerts,
  title,
  emptyMessage,
  onRowClick,
}: {
  alerts: TwinAlert[];
  title: string;
  emptyMessage: string;
  /** Defaults to publishing a store selection; override for page-local behaviour. */
  onRowClick?: (vehicleId: string) => void;
}) {
  const select = useTwin((s) => s.select);
  const hover = useTwin((s) => s.hover);
  const [severityFilter, setSeverityFilter] = useState<AlertSeverity | "all">("all");
  const [collapsed, setCollapsed] = useState(false);
  const [expandedKinds, setExpandedKinds] = useState<ReadonlySet<AlertKind>>(new Set());

  const counts = useMemo(() => {
    const c: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
    for (const a of alerts) c[a.severity] += 1;
    return c;
  }, [alerts]);

  const visible = useMemo(
    () => (severityFilter === "all" ? alerts : alerts.filter((a) => a.severity === severityFilter)),
    [alerts, severityFilter],
  );

  /**
   * Group the in-scope alerts by kind. `alerts` arrives pre-sorted by severity,
   * so insertion order inside each group is already worst-first; the groups
   * themselves are ordered by their worst member, then by size.
   */
  const groups = useMemo(() => {
    const byKind = new Map<AlertKind, TwinAlert[]>();
    for (const a of visible) {
      const bucket = byKind.get(a.kind);
      if (bucket) bucket.push(a);
      else byKind.set(a.kind, [a]);
    }
    return [...byKind.entries()]
      .map(([kind, items]) => ({ kind, items, worst: items[0].severity }))
      .sort((a, b) => SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] || b.items.length - a.items.length);
  }, [visible]);

  const toggleKind = (kind: AlertKind) =>
    setExpandedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const worst: AlertSeverity | null = counts.critical > 0 ? "critical" : counts.warning > 0 ? "warning" : counts.info > 0 ? "info" : null;

  // The severity tint lives on the HEADER only. Tinting the whole panel made
  // a 350 px block of pink that buried the page heading and made every row
  // look equally urgent — the opposite of triage.
  const frame =
    worst === "critical" ? "border-danger/40" : worst === "warning" ? "border-warn/40" : "border-line";
  const headerTint =
    worst === "critical" ? "bg-danger-soft" : worst === "warning" ? "bg-warn-soft" : "bg-surface-2";

  return (
    <section className={`overflow-hidden rounded-xl border bg-surface ${frame} shadow-[var(--shadow)]`} aria-label={title}>
      <header className={`flex flex-wrap items-center gap-3 px-4 py-3 ${headerTint}`}>
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${
            worst === "critical" ? "bg-danger text-white" : worst === "warning" ? "bg-warn text-white" : "bg-surface-3 text-ink-3"
          }`}
          aria-hidden
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4">
            <path d="M8 2.5l6 11H2l6-11z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M8 6.5v3.2M8 11.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>

        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
          <p className="text-[12px] text-ink-2">
            {alerts.length === 0
              ? emptyMessage
              : `${alerts.length} open item${alerts.length === 1 ? "" : "s"} in the current scope`}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {(["critical", "warning", "info"] as AlertSeverity[]).map((s) =>
            counts[s] > 0 ? (
              <button
                key={s}
                type="button"
                onClick={() => setSeverityFilter((prev) => (prev === s ? "all" : s))}
                aria-pressed={severityFilter === s}
                className={`cursor-pointer rounded-full transition ${severityFilter === s ? "ring-2 ring-offset-1 ring-offset-transparent ring-accent/50" : ""}`}
              >
                <Pill tone={SEVERITY_TONE[s]} dot pulse={s === "critical"}>
                  {counts[s]} {SEVERITY_LABEL[s]}
                </Pill>
              </button>
            ) : null,
          )}
          {alerts.length > 0 && (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="cursor-pointer rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-semibold tracking-[0.1em] text-ink-2 transition hover:text-ink"
            >
              {collapsed ? "Show" : "Hide"}
            </button>
          )}
        </div>
      </header>

      {alerts.length > 0 && !collapsed && (
        <div className="scroll-thin max-h-[17rem] overflow-y-auto border-t border-line/70">
          {groups.map((group) => {
            const expanded = expandedKinds.has(group.kind);
            const shown = expanded ? group.items : group.items.slice(0, PREVIEW_ROWS);
            const hidden = group.items.length - shown.length;

            return (
              <section key={group.kind}>
                <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line/70 bg-surface/95 px-4 py-1.5 backdrop-blur-sm">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      group.worst === "critical" ? "bg-danger" : group.worst === "warning" ? "bg-warn" : "bg-info"
                    }`}
                    aria-hidden
                  />
                  <h3 className="text-[11px] font-semibold text-ink-2">
                    {ALERT_KIND_LABEL[group.kind]}
                  </h3>
                  <span className="num text-[11px] font-semibold text-ink-3">{group.items.length}</span>
                  {group.items.length > PREVIEW_ROWS && (
                    <button
                      type="button"
                      onClick={() => toggleKind(group.kind)}
                      aria-expanded={expanded}
                      className="ml-auto cursor-pointer text-[11px] font-semibold tracking-[0.1em] text-accent transition hover:underline"
                    >
                      {expanded ? "Collapse" : `Show all ${group.items.length}`}
                    </button>
                  )}
                </header>

                <ul className="divide-y divide-line">
                  {shown.map((alert) => (
                    <li key={alert.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onMouseEnter={() => hover(alert.vehicleId, "table")}
                        onMouseLeave={() => hover(null)}
                        onClick={() => (onRowClick ? onRowClick(alert.vehicleId) : select(alert.vehicleId, "table"))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            (onRowClick ?? ((id: string) => select(id, "table")))(alert.vehicleId);
                          }
                        }}
                        className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition hover:bg-surface-3/70 focus:outline-none focus-visible:bg-surface-3"
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            alert.severity === "critical" ? "bg-danger" : alert.severity === "warning" ? "bg-warn" : "bg-info"
                          }`}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-ink">{alert.title}</span>
                          <span className="num block truncate text-[11px] text-ink-3">{alert.vehicleId}</span>
                        </span>
                        {alert.metric && (
                          <span className="num shrink-0 text-[12px] font-semibold text-ink-2">{alert.metric}</span>
                        )}
                        <span onClick={(e) => e.stopPropagation()} className="shrink-0">
                          <InfoTip label={`Why ${alert.label} needs attention`}>
                            <span className="block font-semibold text-ink">{alert.label}</span>
                            <span className="mt-1 block">{alert.comment}</span>
                            <SocTrendNote alert={alert} />
                          </InfoTip>
                        </span>
                      </div>
                    </li>
                  ))}

                  {hidden > 0 && (
                    <li>
                      <button
                        type="button"
                        onClick={() => toggleKind(group.kind)}
                        className="w-full cursor-pointer px-4 py-1.5 text-left text-[11px] font-medium text-ink-3 transition hover:bg-surface-3/70 hover:text-ink-2"
                      >
                        + {hidden} more with the same signature
                      </button>
                    </li>
                  )}
                </ul>
              </section>
            );
          })}

          {groups.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-ink-3">No {severityFilter} items in scope.</p>
          )}
        </div>
      )}

    </section>
  );
}

/**
 * Observed SOC context for a flagged pack.
 *
 * Answers "how fast is this moving?" using only frames the dashboard has
 * actually seen this session (see `lib/soc-history.ts`). With one frame it
 * says so plainly rather than printing a rate it cannot know — a fabricated
 * "dropped 1% in 5 min" is worse than an honest "establishing baseline",
 * because an operator would act on it.
 *
 * Only rendered for SOC alerts; a stale-GPS row has no charge trend to show.
 */
function SocTrendNote({ alert }: { alert: TwinAlert }) {
  const trend = useSocTrend(alert.vehicleId);
  if (alert.kind !== "soc-critical" && alert.kind !== "soc-low") return null;

  return (
    <span className="mt-1.5 block border-t border-line pt-1.5">
      <span className="block font-semibold text-ink">Observed trend</span>
      {trend ? (
        <span className="block">
          {alert.label} {trend.label}.
          {trend.deltaPct < 0
            ? " Continued discharge at this rate shortens the window before the reserve."
            : ""}
        </span>
      ) : (
        <span className="block">
          Establishing a baseline — a rate needs two distinct frames, and only one has been
          observed so far. It appears here as soon as the upstream publishes the next.
        </span>
      )}
    </span>
  );
}
