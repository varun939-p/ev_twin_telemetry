"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { DraftBadge } from "@/components/ui/Pill";
import { usePersistedBool } from "@/lib/persisted";

/**
 * Primary navigation rail.
 *
 * Replaces `ViewNav` (two floating "cards" that duplicated the deleted banner
 * headers).  `Digital Twin` is a real expandable heading owning exactly the
 * six routes in the spec; drafts are labelled as drafts in the nav itself so
 * nobody clicks into the 3:00 PM scaffolds expecting depth.
 *
 * Behaviour:
 *   * active route resolved from `usePathname` (prefix match, so nested
 *     detail routes keep their parent highlighted)
 *   * the group's expanded/collapsed state persists in localStorage
 *   * < lg the rail becomes an off-canvas drawer driven by `open`
 */

export interface NavItem {
  href: string;
  label: string;
  hint: string;
  draft?: boolean;
  icon: ReactNode;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const NAV_ITEMS: NavItem[] = [
  {
    href: "/digital-twin/central",
    label: "Central Dashboard",
    hint: "Live site canvas",
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <path d="M10 2.5L17 7v9.5H3V7l7-4.5z" {...stroke} />
        <path d="M7.5 16.5v-5h5v5" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/battery-tracking",
    label: "Battery Tracking",
    hint: "Packs, SOH, analytics",
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <rect x="2.5" y="6" width="13" height="8" rx="2" {...stroke} />
        <path d="M17.5 9v2" {...stroke} />
        <path d="M6 8.5v3M9 8.5v3" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/truck-telemetry",
    label: "Truck Telemetry",
    hint: "Carriers on the map",
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <path d="M2.5 13.5V5.5h9v8" {...stroke} />
        <path d="M11.5 8h3l3 3v2.5h-6" {...stroke} />
        <circle cx="6" cy="14.5" r="1.6" {...stroke} />
        <circle cx="14.5" cy="14.5" r="1.6" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/swap-station",
    label: "Swap Station",
    hint: "Bays, ETA, density",
    draft: true,
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <path d="M3 16.5V7l7-4 7 4v9.5" {...stroke} />
        <rect x="6.5" y="10" width="7" height="6.5" rx="1" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/chargers",
    label: "Chargers",
    hint: "Dual-gun units",
    draft: true,
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <rect x="4" y="2.5" width="9" height="15" rx="2" {...stroke} />
        <path d="M13 7h2.5v5.5a1.5 1.5 0 01-3 0" {...stroke} />
        <path d="M9.5 6.5L7 10.5h3L7.5 14" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/dg",
    label: "DG",
    hint: "Backup generator",
    draft: true,
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <rect x="2.5" y="6.5" width="15" height="8" rx="2" {...stroke} />
        <path d="M6 6.5V4.5h8v2" {...stroke} />
        <path d="M6 10.5h3.5M12 10.5h2" {...stroke} />
      </svg>
    ),
  },
];

const STORAGE_KEY = "twin.nav.expanded";

export default function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const pathname = usePathname();
  const [expanded, setExpanded] = usePersistedBool(STORAGE_KEY, true);
  const toggleGroup = () => setExpanded(!expanded);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const groupActive = pathname.startsWith("/digital-twin");

  return (
    <>
      {/* scrim — mobile drawer only */}
      <div
        aria-hidden
        onClick={onNavigate}
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity lg:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        aria-label="Primary"
        className={`fixed inset-y-0 left-0 z-40 flex w-[248px] shrink-0 flex-col border-r border-line bg-surface transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* brand */}
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">
            ⌁
          </span>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold tracking-tight text-ink">Twin Ops</p>
            <p className="text-[9px] uppercase tracking-[0.14em] text-ink-3">Proprietary EMS</p>
          </div>
        </div>

        <nav className="scroll-thin flex-1 overflow-y-auto p-3">
          <button
            type="button"
            onClick={toggleGroup}
            aria-expanded={expanded}
            className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left transition hover:bg-surface-3 ${
              groupActive ? "text-ink" : "text-ink-2"
            }`}
          >
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em]">Digital Twin</span>
            <svg
              viewBox="0 0 12 12"
              className={`h-3 w-3 text-ink-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
              aria-hidden
            >
              <path d="M2 4.5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {expanded && (
            <ul className="mt-1 space-y-0.5 border-l border-line pl-2">
              {NAV_ITEMS.map((item) => {
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition ${
                        active
                          ? "bg-accent-soft text-accent"
                          : "text-ink-2 hover:bg-surface-3 hover:text-ink"
                      }`}
                    >
                      <span className={`mt-[1px] shrink-0 ${active ? "text-accent" : "text-ink-3 group-hover:text-ink-2"}`}>
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium">{item.label}</span>
                          {item.draft && <DraftBadge />}
                        </span>
                        <span className="mt-0.5 block truncate text-[10px] text-ink-3">{item.hint}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t border-line px-4 py-3">
          <p className="text-[10px] leading-relaxed text-ink-3">
            Rendering only telemetry that passed the backend validation gates. Unmeasured channels show as
            <span className="num text-ink-2"> — </span>, never 0.
          </p>
        </div>
      </aside>
    </>
  );
}
