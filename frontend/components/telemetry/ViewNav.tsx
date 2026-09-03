import Link from "next/link";

/**
 * ViewNav -- the 2-phase navigation rail.
 *
 * Product directive (executive demo): exactly two tabs are exposed --
 *
 *   1. Fleet Twin       `/`        full 24-parameter validation view
 *   2. Trucks Dashboard `/trucks`  carrier lens
 *
 * Batteries and Optimizer / P&L are hidden from navigation.  The routes remain
 * reachable by URL for engineering, but the demo surface is strictly 2-phase.
 */
export type ViewNavTarget = "fleet" | "trucks";

const TABS: ReadonlyArray<{ id: Exclude<ViewNavTarget, never>; href: string; title: string; sub: string }> = [
  { id: "fleet", href: "/", title: "Fleet Twin", sub: "Full 24-parameter validation view" },
  { id: "trucks", href: "/trucks", title: "Trucks Dashboard", sub: "Carriers · SOC, range, odo, temp" },
];

export default function ViewNav({ active }: { active?: ViewNavTarget }) {
  const card = (isActive: boolean) =>
    `rounded-xl border px-4 py-3 transition ${
      isActive ? "border-cyan-400/30 bg-cyan-400/[0.08]" : "border-white/[0.07] bg-slate-900/40 hover:border-white/[0.16] hover:bg-slate-900/70"
    }`;

  return (
    <nav aria-label="Digital Twin views" className="mx-auto max-w-[1680px] px-5 pt-5 lg:px-8">
      <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.24em] text-slate-600">Digital Twin</p>
      <div className="grid grid-cols-2 gap-3 md:max-w-md">
        {TABS.map((tab) => (
          <Link key={tab.id} href={tab.href} className={card(active === tab.id)}>
            <p className="text-xs font-semibold text-white">{tab.title}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">{tab.sub}</p>
          </Link>
        ))}
      </div>
    </nav>
  );
}
