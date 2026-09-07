"use client";

import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import AutoIngestTrigger from "@/components/shell/AutoIngestTrigger";
import LiveClock from "@/components/shell/LiveClock";
import Sidebar, { NAV_ITEMS } from "@/components/shell/Sidebar";
import { Pill } from "@/components/ui/Pill";
import type { TelemetrySource } from "@/lib/trusted-telemetry";

/**
 * Application shell: rail + top bar + content column.
 *
 * The old build had no shell — every page re-declared its own header, which is
 * how five different "banner cards" ended up in the product.  There is now
 * exactly ONE place that renders chrome, and pages render content only.
 *
 * `feedAgeLabel` is computed on the server (from the document's newest
 * validated frame) and passed down as a string, so the shell never needs the
 * 260 KB telemetry document in the client bundle.
 */
export default function AppShell({
  children,
  feedAgeLabel,
  frameCount,
  measuredChannels,
  source,
  sourceNote,
  canBootstrap = false,
}: {
  children: ReactNode;
  feedAgeLabel: string;
  frameCount: number;
  /** How many of the 24 channels the upstream is currently measuring. */
  measuredChannels: number;
  /** Whether this render is live, cache-carried, or still waiting for data. */
  source: TelemetrySource;
  /** Why we fell back, when we did. Never hidden from the operator. */
  sourceNote: string | null;
  canBootstrap?: boolean;
}) {
  const pathname = usePathname();
  // The drawer closes from `onNavigate` (fired by every nav Link and by the
  // scrim) rather than from a pathname effect: navigating is the event, and
  // reacting to it in an effect would be a cascading render for no gain.
  const [navOpen, setNavOpen] = useState(false);

  const current = NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));

  return (
    // `min-h-screen` guarantees the shell fills short viewports; `w-full` +
    // `min-w-0` on the content column stop a wide table from forcing the whole
    // page to scroll horizontally (flex children default to min-width:auto,
    // which is the classic cause of that bug).
    <div className="flex min-h-screen w-full bg-canvas">
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md lg:px-6">
          <button
            type="button"
            onClick={() => setNavOpen((v) => !v)}
            aria-label="Toggle navigation"
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border border-line text-ink-2 transition hover:bg-surface-3 hover:text-ink lg:hidden"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
              <path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>

          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
            <span className="hidden text-xs font-medium text-ink-3 sm:inline">Digital Twin</span>
            <span className="hidden text-ink-3 sm:inline" aria-hidden>
              /
            </span>
            <span className="truncate text-[13px] font-semibold text-ink">{current?.label ?? "Overview"}</span>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {/* Provenance, stated plainly — three states, never a guess.
                "Live" means the control plane answered THIS render (proved by
                an uncached health probe, because the document itself may have
                come from the stale-while-revalidate cache). "Cached" means the
                feed is down but the last good document is still on screen.
                "Waiting" means there is no document yet — the database is
                empty (first deploy, cron not fired, credentials pending) or
                unreachable; the tooltip names the reason. An operator must
                never have to wonder which of the three they are looking at. */}
            <Pill
              tone={source === "live" ? "ok" : source === "cached" ? "warn" : "neutral"}
              dot
              pulse={source === "live"}
              className="hidden md:inline-flex"
              title={
                source === "live"
                  ? `Connected to the control plane (not a freshness guarantee). ${frameCount} validated frames, ${measuredChannels} of 24 channels measured. Freshest observation: ${feedAgeLabel}.`
                  : `${sourceNote ?? "Upstream unavailable."} ${frameCount} validated frames, ${measuredChannels} of 24 channels measured. Freshest observation: ${feedAgeLabel}.`
              }
            >
              {source === "live" ? "Connected" : source === "cached" ? "Cached" : "Waiting"} ·{" "}
              <span className="num">{frameCount}</span> frames · <span className="num">{measuredChannels}</span>/24 ·{" "}
              {feedAgeLabel}
            </Pill>
            <LiveClock />
          </div>
        </header>

        {/* The 1920px ceiling is a no-op on every standard monitor and stops
            an ultrawide display stretching cards and prose to unreadable
            line lengths. */}
        <main className="mx-auto w-full min-w-0 max-w-[1920px] flex-1 px-4 py-5 lg:px-6 lg:py-6">
          {children}
        </main>
      </div>

      {/* Local bootstrap only; production is scheduled independently. */}
      <AutoIngestTrigger source={source} sourceNote={sourceNote} enabled={canBootstrap} />
    </div>
  );
}
