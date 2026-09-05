"use client";

import { useSyncExternalStore } from "react";

/**
 * Live IST clock — the reference wall time for every "age" shown on the pages.
 *
 * `useSyncExternalStore` (not effect + setState): the clock is an external
 * system, and quantising the snapshot to whole seconds keeps the server render
 * deterministic, so a statically prerendered page cannot mismatch on hydration.
 */
const clockStore = {
  subscribe(onChange: () => void) {
    const id = setInterval(onChange, 1000);
    return () => clearInterval(id);
  },
  getSnapshot: () => Math.floor(Date.now() / 1000) * 1000,
  getServerSnapshot: () => 0,
};

export default function LiveClock({ compact = false }: { compact?: boolean }) {
  const stamp = useSyncExternalStore(clockStore.subscribe, clockStore.getSnapshot, clockStore.getServerSnapshot);
  const now = stamp === 0 ? null : new Date(stamp);

  const time = now?.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const date = now?.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-[5px]"
      title="Live system time (IST) — the reference clock for every telemetry age on this page"
    >
      <span className="relative flex h-1.5 w-1.5" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
      </span>
      <span className="num text-xs font-semibold text-ink">{time ?? "--:--:--"}</span>
      {!compact && <span className="hidden text-[10px] text-ink-3 sm:inline">{date ?? "—"} IST</span>}
    </div>
  );
}
