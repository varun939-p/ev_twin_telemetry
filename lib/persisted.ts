"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * localStorage-backed booleans, subscribed rather than mirrored.
 *
 * Same reasoning as `lib/theme`: `localStorage` is an external system, so it
 * is read through `useSyncExternalStore` with a deterministic server snapshot.
 * That gives warning-free hydration (React renders the server snapshot, then
 * swaps to the stored value) without a `setState` inside an effect.
 */

const listeners = new Map<string, Set<() => void>>();

function emit(key: string) {
  listeners.get(key)?.forEach((cb) => cb());
}

export function usePersistedBool(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(onChange);
      window.addEventListener("storage", onChange);
      return () => {
        set.delete(onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    [key],
  );

  const getSnapshot = useCallback(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  }, [key, fallback]);

  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback);

  const set = useCallback(
    (next: boolean) => {
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* non-fatal */
      }
      emit(key);
    },
    [key],
  );

  return [value, set];
}

/**
 * localStorage-backed string value with a hydration-safe `null` server
 * snapshot. Keeping the snapshot primitive is important: returning a freshly
 * parsed array from `getSnapshot` would make React treat every read as a store
 * change. Callers can parse JSON with `useMemo` after subscribing.
 */
export function usePersistedString(key: string): [string | null, (next: string | null) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(onChange);
      window.addEventListener("storage", onChange);
      return () => {
        set.delete(onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    [key],
  );

  const getSnapshot = useCallback(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }, [key]);

  const value = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const set = useCallback(
    (next: string | null) => {
      try {
        if (next === null) localStorage.removeItem(key);
        else localStorage.setItem(key, next);
      } catch {
        /* Storage is an enhancement; navigation still works without it. */
      }
      emit(key);
    },
    [key],
  );

  return [value, set];
}
