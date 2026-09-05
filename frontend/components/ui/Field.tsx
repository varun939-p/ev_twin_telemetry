"use client";

import type { ReactNode } from "react";

/**
 * Form atoms for the filter bars.
 *
 * Native `<select>` under a custom chrome: keyboard, mobile pickers and
 * screen-reader semantics come free, and the appearance is normalised so it
 * cannot revert to the OS widget in either theme.
 */

export function Select<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled = false,
  placeholder,
  className = "",
}: {
  label: string;
  value: T | null;
  onChange: (next: T | null) => void;
  options: ReadonlyArray<{ value: T; label: string; badge?: number | string }>;
  disabled?: boolean;
  placeholder: string;
  className?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-3">{label}</span>
      <span className="relative block">
        <select
          aria-label={label}
          disabled={disabled}
          value={value ?? ""}
          onChange={(e) => onChange((e.target.value || null) as T | null)}
          className="w-full cursor-pointer appearance-none rounded-lg border border-line bg-surface py-[7px] pl-2.5 pr-7 text-xs font-medium text-ink outline-none transition hover:border-line-strong focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-3"
        >
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.badge !== undefined ? ` · ${o.badge}` : ""}
            </option>
          ))}
        </select>
        <svg viewBox="0 0 12 12" aria-hidden className="pointer-events-none absolute right-2 top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-ink-3">
          <path d="M2 4.5l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </label>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
  className = "",
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string; count?: number; disabled?: boolean }>;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-3">{label}</span>
      <div role="group" aria-label={label} className="flex overflow-hidden rounded-lg border border-line bg-surface">
        {options.map((o, i) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              disabled={o.disabled}
              onClick={() => onChange(o.value)}
              className={`cursor-pointer px-3 py-[7px] text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                i > 0 ? "border-l border-line" : ""
              } ${active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-surface-3 hover:text-ink"}`}
            >
              {o.label}
              {o.count !== undefined && <span className="num ml-1.5 text-[11px] text-ink-3">{o.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Removable chip for an active narrowing (map drill-down, deep link, ...). */
export function FilterChip({
  children,
  onClear,
  tone = "accent",
}: {
  children: ReactNode;
  onClear: () => void;
  tone?: "accent" | "info";
}) {
  const cls = tone === "accent" ? "border-accent/30 bg-accent-soft text-accent" : "border-info/30 bg-info-soft text-info";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${cls}`}>
      {children}
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear this filter"
        className="cursor-pointer rounded-full px-1 leading-none opacity-70 transition hover:opacity-100"
      >
        ✕
      </button>
    </span>
  );
}

export function GhostButton({
  children,
  onClick,
  title,
  className = "",
  tone = "neutral",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
  className?: string;
  tone?: "neutral" | "accent" | "danger";
  type?: "button" | "submit";
}) {
  const tones = {
    neutral: "border-line text-ink-2 hover:border-line-strong hover:bg-surface-3 hover:text-ink",
    accent: "border-accent/40 bg-accent-soft text-accent hover:bg-accent/15",
    danger: "border-danger/35 bg-danger-soft text-danger hover:bg-danger/15",
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-[7px] text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}
