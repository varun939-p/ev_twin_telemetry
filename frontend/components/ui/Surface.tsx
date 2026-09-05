import type { ReactNode } from "react";

/**
 * Surface primitives.
 *
 * One card definition for the whole product: the previous build had four
 * slightly different `rounded-2xl border border-white/[0.06] bg-slate-900/40`
 * strings copy-pasted across pages, which is why the old UI drifted.  These
 * are plain (server-renderable) components — no client boundary is paid for a
 * box.
 */

export function Card({
  children,
  className = "",
  as: As = "section",
  padded = false,
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article" | "aside";
  padded?: boolean;
}) {
  return (
    <As
      className={`rounded-xl border border-line bg-surface shadow-[var(--shadow)] ${padded ? "p-5" : ""} ${className}`}
    >
      {children}
    </As>
  );
}

export function CardHeader({
  eyebrow,
  title,
  description,
  actions,
  className = "",
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-wrap items-start justify-between gap-3 px-5 pb-4 pt-5 ${className}`}>
      <div className="min-w-0">
        {eyebrow && <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-3">{eyebrow}</p>}
        <h2 className="mt-1 text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Hairline({ className = "" }: { className?: string }) {
  return <div className={`h-px w-full bg-line ${className}`} />;
}

export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-3 ${className}`}>{children}</p>
  );
}

/** Page-level heading. Replaces the deleted banner cards: a line of text, not
 *  a 120px slab of gradient. */
export function PageHeading({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-xs text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {hint && <p className="max-w-md text-xs text-ink-3">{hint}</p>}
    </div>
  );
}
