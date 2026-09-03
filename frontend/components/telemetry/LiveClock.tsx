"use client";

import { useSyncExternalStore } from "react";

/** One shared subscription for every clock on the page, created once. */
const clockStore = {
  subscribe(onChange: () => void) {
    const id = setInterval(onChange, 1000);
    return () => clearInterval(id);
  },
  /** Quantised to the second: a stable snapshot between ticks, so React never
   *  sees a changed value without a store notification. */
  getSnapshot: () => Math.floor(Date.now() / 1000) * 1000,
  /** The prerendered HTML has no clock in it; 0 renders the placeholder. */
  getServerSnapshot: () => 0,
};

/**
 * Prominent live system clock for the dashboard header.
 *
 * Renders IST (the operating timezone of the fleet) and ticks once a second.
 * `useSyncExternalStore` rather than an effect + setState: the clock is an
 * external system, and this keeps the server render deterministic so the
 * statically prerendered page cannot mismatch on hydration.
 */
export default function LiveClock({ className = "" }: { className?: string }) {
  const stamp = useSyncExternalStore(clockStore.subscribe, clockStore.getSnapshot, clockStore.getServerSnapshot);
  const now = stamp === 0 ? null : new Date(stamp);

  const date = now?.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  const time = now?.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div
      className={`flex items-center gap-2.5 rounded-xl border border-white/[0.08] bg-black/30 px-3.5 py-2 ${className}`}
      title="Live system time — the reference clock for all telemetry ages on this page"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
      </span>
      <div className="leading-tight">
        <p className="font-mono text-sm font-semibold tabular-nums text-white">{time ?? "--:--:--"}</p>
        <p className="text-[9px] uppercase tracking-[0.18em] text-slate-500">{date ?? "—"} · IST</p>
      </div>
    </div>
  );
}
