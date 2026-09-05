"use client";

import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import LiveClock from "@/components/shell/LiveClock";
import Sidebar, { NAV_ITEMS } from "@/components/shell/Sidebar";
import ThemeToggle from "@/components/shell/ThemeToggle";
import { Pill } from "@/components/ui/Pill";

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
}: {
  children: ReactNode;
  feedAgeLabel: string;
  frameCount: number;
}) {
  const pathname = usePathname();
  // The drawer closes from `onNavigate` (fired by every nav Link and by the
  // scrim) rather than from a pathname effect: navigating is the event, and
  // reacting to it in an effect would be a cascading render for no gain.
  const [navOpen, setNavOpen] = useState(false);

  const current = NAV_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));

  return (
    <div className="flex min-h-screen bg-canvas">
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
            {current?.draft && (
              <Pill tone="warn" className="ml-1">
                Draft
              </Pill>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Pill
              tone="neutral"
              dot
              className="hidden md:inline-flex"
              title={`${frameCount} validated frames in the loaded document. Freshest observation: ${feedAgeLabel}.`}
            >
              <span className="num">{frameCount}</span> frames · {feedAgeLabel}
            </Pill>
            <LiveClock />
            <ThemeToggle />
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 lg:px-6 lg:py-6">{children}</main>
      </div>
    </div>
  );
}
