"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * Hover / focus tooltip for the alert icons.
 *
 * Deliberately not a portal: it must sit inside the alert row so the pointer
 * can travel from the icon into the bubble without dismissing it.  Placement
 * is CSS-only (above, right-anchored, flipping to below on the first rows via
 * `placement`), which keeps it dependency-free and jank-free — no measuring
 * pass, no layout thrash while a list of 20 alerts scrolls.
 *
 * Opens on hover AND on keyboard focus, so it is not a mouse-only affordance.
 */
export default function InfoTip({
  children,
  label = "More context",
  placement = "top",
  width = "w-72",
}: {
  children: ReactNode;
  label?: string;
  placement?: "top" | "bottom";
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="grid h-[18px] w-[18px] cursor-help place-items-center rounded-full border border-line-strong text-[11px] font-bold text-ink-2 transition hover:border-accent hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`rise-in pointer-events-none absolute right-0 z-50 ${width} rounded-lg border border-line bg-surface p-3 text-left text-[12px] leading-relaxed font-normal normal-case tracking-normal text-ink-2 shadow-[var(--shadow)] ${
            placement === "top" ? "bottom-[26px]" : "top-[26px]"
          }`}
        >
          {children}
        </span>
      )}
    </span>
  );
}
