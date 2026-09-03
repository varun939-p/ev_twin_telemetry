import Link from "next/link";

/**
 * Linking cards under the "Digital Twin" menu section.
 *
 * Mirrors the Optimizer card pattern: the twin splits into two asset lenses --
 * Trucks (carriers) and Batteries (the tracked asset) -- each a routed page.
 * Optimizer / P&L is shown but non-clickable: it is explicitly paused pending
 * the Blue Energy Motors meetings, so it must not look actionable.
 */
export default function ViewNav({ active }: { active: "fleet" | "trucks" | "batteries" }) {
  const card = (isActive: boolean) =>
    `rounded-xl border px-4 py-3 transition ${
      isActive ? "border-cyan-400/30 bg-cyan-400/[0.08]" : "border-white/[0.07] bg-slate-900/40 hover:border-white/[0.16] hover:bg-slate-900/70"
    }`;

  return (
    <nav aria-label="Digital Twin views" className="mx-auto max-w-[1680px] px-5 pt-5 lg:px-8">
      <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.24em] text-slate-600">Digital Twin</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Link href="/" className={card(active === "fleet")}>
          <p className="text-xs font-semibold text-white">Fleet Twin</p>
          <p className="mt-0.5 text-[10px] text-slate-500">Full 24-parameter validation view</p>
        </Link>
        <Link href="/trucks" className={card(active === "trucks")}>
          <p className="text-xs font-semibold text-white">Trucks Dashboard</p>
          <p className="mt-0.5 text-[10px] text-slate-500">Carriers · SOC, range, odo, temp</p>
        </Link>
        <Link href="/batteries" className={card(active === "batteries")}>
          <p className="text-xs font-semibold text-white">Batteries Dashboard</p>
          <p className="mt-0.5 text-[10px] text-slate-500">Packs · SOH, cycles, regen, ETA</p>
        </Link>
        <div className={`${card(false)} cursor-not-allowed opacity-50`} title="Paused pending client meetings with Blue Energy Motors">
          <p className="text-xs font-semibold text-slate-300">Optimizer / P&amp;L</p>
          <p className="mt-0.5 text-[10px] text-slate-500">Paused — energy trading tuning</p>
        </div>
      </div>
    </nav>
  );
}
