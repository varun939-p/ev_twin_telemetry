/**
 * jsdom shims so the REAL Leaflet map can mount in the test suite.
 *
 * Imported FIRST in fleet-map.test.tsx — module bodies execute in import
 * order, and these patches must exist before Leaflet ever touches the DOM.
 *
 * What Leaflet needs in jsdom that jsdom does not provide:
 *   * a 2D canvas context (the `canvas` npm package is a heavy native build —
 *     a no-op Proxy context keeps `preferCanvas` rendering, whose hit-testing
 *     is pure geometry, not pixel reads)
 *   * a non-zero container size (`clientWidth/Height` are always 0 in jsdom,
 *     which would make every projection divide by zero)
 */

type AnyRecord = Record<string | symbol, unknown>;

function stubContext2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, prop: string | symbol) {
      if (prop === "canvas") return canvas;
      // Every method is a callable no-op; every read is undefined-safe.
      return () => undefined;
    },
    set() {
      return true; // swallow style writes (lineCap, fillStyle, ...)
    },
  });
}

function defineGet(prototype: HTMLElement, prop: string, value: number) {
  Object.defineProperty(prototype, prop, { configurable: true, get: () => value });
}

defineGet(HTMLElement.prototype, "clientWidth", 800);
defineGet(HTMLElement.prototype, "clientHeight", 600);

const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement["getContext"]>) {
  // Only the 2d context is stubbed; anything else keeps jsdom's behaviour.
  if (args[0] === "2d") return stubContext2d(this);
  return originalGetContext.apply(this, args);
} as typeof HTMLCanvasElement.prototype.getContext;

/** Captured Leaflet map instances (addInitHook runs on every `L.map(...)`). */
/* eslint-disable @typescript-eslint/no-explicit-any */
const maps: any[] = [];

// Leaflet must be imported AFTER the prototype patches above for the canvas
// probe, but the context stub is only consulted at render time, so a static
// import is safe here.
import L from "leaflet";

L.Map.addInitHook(function (this: L.Map) {
  maps.push(this);
});

/**
 * Leaflet's destroy path deletes `_ctx` but a queued `_redraw` rAF frame can
 * still fire afterwards (its cancel covers only some of the animation ids).
 * In jsdom that surfaces as an uncaught `undefined.clearRect` after the test
 * has passed. A torn-down canvas has nothing to redraw — skip those frames.
 */
const origRedraw = (L.Canvas.prototype as unknown as { _redraw: () => void })._redraw;
(L.Canvas.prototype as unknown as { _redraw: () => void })._redraw = function (this: { _ctx?: unknown }) {
  if (!this._ctx) return;
  origRedraw.call(this);
};

export function lastMap(): L.Map | null {
  return (maps.at(-1) as L.Map | undefined) ?? null;
}

export function resetMaps() {
  maps.length = 0;
}

export type { AnyRecord };
