"use client";

/**
 * Theme controller — explicit Dark / Light with a "System" third state.
 *
 * WHY `useSyncExternalStore` AND NOT `useEffect` + `setState`
 * ----------------------------------------------------------
 * The theme lives in TWO external systems: `localStorage` (the user's explicit
 * choice) and the `prefers-color-scheme` media query (the OS). Mirroring them
 * into React state from an effect causes a cascading render on every mount and
 * is exactly what React 19's `set-state-in-effect` rule flags. Subscribing to
 * them instead gives us:
 *   * a deterministic server snapshot ("system"), so hydration cannot mismatch
 *   * cross-tab sync for free (the `storage` event)
 *   * OS changes applied from the media-query callback, not from a render pass
 *
 * The resolved theme is expressed as a single `.dark` class on <html> — the
 * hook Tailwind's `@custom-variant dark` is wired to (see globals.css).
 * First paint is handled by `THEME_BOOTSTRAP_SCRIPT` in <head>, which runs
 * before hydration so a dark reload never flashes white.
 */

import { useCallback, useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "twin.theme";
const CHANGE_EVENT = "twin:theme";

/** Runs before React hydrates; keep it dependency-free and tiny. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var p=localStorage.getItem("${STORAGE_KEY}");var m=window.matchMedia("(prefers-color-scheme: dark)").matches;var d=p==="dark"||((!p||p==="system")&&m);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

/* --------------------------------------------------------------- store */

/** Snapshot is a single string ("<preference>|<resolved>") so `Object.is`
 *  comparison is cheap and the cached value is stable between reads. */
let snapshot = "system|light";
const SERVER_SNAPSHOT = "system|light";

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getSnapshot(): string {
  const preference = readPreference();
  const resolved = preference === "system" ? systemTheme() : preference;
  const next = `${preference}|${resolved}`;
  // Only swap the cached string when it actually changed: React compares
  // snapshots by identity and would loop on a fresh value every read.
  if (next !== snapshot) snapshot = next;
  return snapshot;
}

function getServerSnapshot(): string {
  return SERVER_SNAPSHOT;
}

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    // Applying the class here (an external-system callback) rather than in an
    // effect keeps the DOM and React in step without a cascading render.
    applyResolved(readPreference() === "system" ? systemTheme() : readPreference() as ResolvedTheme);
    onChange();
  };
  mq.addEventListener("change", handler);
  window.addEventListener("storage", handler);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => {
    mq.removeEventListener("change", handler);
    window.removeEventListener("storage", handler);
    window.removeEventListener(CHANGE_EVENT, handler);
  };
}

function applyResolved(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

/* ---------------------------------------------------------------- hook */

export interface ThemeApi {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  /** Light <-> Dark; never lands on "system" (use `setPreference` for that). */
  toggle: () => void;
}

export function useTheme(): ThemeApi {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [preference, resolved] = value.split("|") as [ThemePreference, ResolvedTheme];

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode — the DOM class below still applies for this session */
    }
    applyResolved(next === "system" ? systemTheme() : next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const toggle = useCallback(
    () => setPreference(resolved === "dark" ? "light" : "dark"),
    [resolved, setPreference],
  );

  return { preference, resolved, setPreference, toggle };
}
