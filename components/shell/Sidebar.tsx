"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { usePersistedBool } from "@/lib/persisted";

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Draft routes are functional previews but intentionally visually quieter. */
  draft?: boolean;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** The product's canonical seven-screen order. */
export const NAV_ITEMS: NavItem[] = [
  {
    href: "/digital-twin/central",
    label: "Central Dashboard",
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
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <rect x="2.5" y="6" width="13" height="8" rx="2" {...stroke} />
        <path d="M17.5 9v2M6 8.5v3M9 8.5v3" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/truck-telemetry",
    label: "Truck Telemetry",
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <path d="M2.5 13.5V5.5h9v8M11.5 8h3l3 3v2.5h-6" {...stroke} />
        <circle cx="6" cy="14.5" r="1.6" {...stroke} />
        <circle cx="14.5" cy="14.5" r="1.6" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/swap-station/overview",
    label: "Swap Station",
    draft: true,
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <path d="M3 7.5h14v8H3zM6 4.5h8v3M6.5 11h7M10 8.5v5" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/charging-station",
    label: "Charging Station",
    draft: true,
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <rect x="3.5" y="3" width="8.5" height="14" rx="2" {...stroke} />
        <path d="M6 6h3.5M12 7h2.2l2.3 2.5v4.2a1.8 1.8 0 01-3.6 0v-2.2M8.8 9l-2 2.7h2l-1.7 2.2" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/dg/overview",
    label: "DG",
    draft: true,
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <rect x="2.5" y="5" width="15" height="10.5" rx="2" {...stroke} />
        <circle cx="7" cy="10.3" r="2.3" {...stroke} />
        <path d="M11.5 8h3.2M11.5 10.5h3.2M11.5 13h2" {...stroke} />
      </svg>
    ),
  },
  {
    href: "/digital-twin/predictive-analysis",
    label: "Predictive Analysis",
    draft: true,
    icon: (
      <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
        <path d="M3 15.5h14M4.5 13l3.2-3 2.3 1.7 4.7-5" {...stroke} />
        <circle cx="4.5" cy="13" r="1" fill="currentColor" />
        <circle cx="7.7" cy="10" r="1" fill="currentColor" />
        <circle cx="10" cy="11.7" r="1" fill="currentColor" />
        <circle cx="14.7" cy="6.7" r="1" fill="currentColor" />
      </svg>
    ),
  },
];

const STORAGE_KEY = "twin.nav.expanded";

export default function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const pathname = usePathname();
  const [expanded, setExpanded] = usePersistedBool(STORAGE_KEY, true);
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const groupActive = pathname.startsWith("/digital-twin");

  return (
    <>
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
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">⌁</span>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold tracking-tight text-ink">Twin Ops</p>
            <p className="text-[10px] text-ink-3">Proprietary EMS</p>
          </div>
        </div>

        <nav className="scroll-thin flex-1 overflow-y-auto p-3">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left transition hover:bg-surface-3 ${
              groupActive ? "text-ink" : "text-ink-2"
            }`}
          >
            <span className="text-[12px] font-semibold">Digital Twin</span>
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
                  <li key={item.href} className={item.draft ? "opacity-60" : undefined}>
                    <Link
                      href={item.href}
                      prefetch
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      title={item.draft ? `${item.label} — draft view` : item.label}
                      className={`group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${
                        active
                          ? "bg-accent-soft text-accent"
                          : "text-ink-2 hover:bg-surface-3 hover:text-ink"
                      }`}
                    >
                      <span className={`mt-[1px] shrink-0 ${active ? "text-accent" : "text-ink-3 group-hover:text-ink-2"}`}>
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.label}</span>
                      {item.draft && (
                        <span className="mt-0.5 rounded bg-surface-3 px-1 py-0.5 text-[8px] font-bold tracking-[0.08em] text-ink-3">
                          DRAFT
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
      </aside>
    </>
  );
}
