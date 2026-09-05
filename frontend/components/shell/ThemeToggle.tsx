"use client";

import { useTheme } from "@/lib/theme";

/**
 * Dark / Light toggle.
 *
 * Three-state under the hood (light / dark / system) but a single-click
 * affordance: the button flips light<->dark, and a long-press-free
 * right-hand chip resets to "system".  The icon reflects the RESOLVED theme,
 * so it always answers "what am I looking at", not "what did I choose".
 */
export default function ThemeToggle() {
  const { resolved, preference, toggle, setPreference } = useTheme();
  const isDark = resolved === "dark";

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
        title={`${isDark ? "Dark" : "Light"} mode${preference === "system" ? " (following system)" : ""} — click to switch`}
        className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg border border-line bg-surface text-ink-2 transition hover:border-line-strong hover:bg-surface-3 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {isDark ? (
          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
            <path
              d="M16.5 11.8A7 7 0 018.2 3.5a7 7 0 108.3 8.3z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden>
            <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M10 2v2M10 16v2M2 10h2M16 10h2M4.4 4.4l1.4 1.4M14.2 14.2l1.4 1.4M15.6 4.4l-1.4 1.4M5.8 14.2l-1.4 1.4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>

      {preference !== "system" && (
        <button
          type="button"
          onClick={() => setPreference("system")}
          title="Follow the operating system theme"
          className="hidden cursor-pointer rounded-md border border-line px-1.5 py-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-ink-3 transition hover:border-line-strong hover:text-ink-2 sm:block"
        >
          Auto
        </button>
      )}
    </div>
  );
}
