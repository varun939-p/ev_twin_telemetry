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
