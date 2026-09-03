"use client";

import { useEffect, useState } from "react";

/**
 * Prominent live system clock for the dashboard header.
 *
 * Renders IST (the operating timezone of the fleet) and ticks once a second.
 * Client-only state, so it never leaks into the static HTML / SSR output.
 */
export default function LiveClock({ className = "" }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

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
