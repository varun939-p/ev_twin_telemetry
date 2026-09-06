import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("Vercel rewrite targets the exact Python function URL, carrying the route in the query", async () => {
  vi.stubEnv("VERCEL", "1");
  vi.resetModules();
  const { default: config } = await import("../../next.config.mjs");
  const [rewrite] = await config.rewrites();
  expect(rewrite.destination).toBe("/api/index.py?__telemetry_path=:path*");
  // Exercise this Next version's actual wildcard-to-query substitution too.
  const { prepareDestination } = await import("next/dist/shared/lib/router/utils/prepare-destination");
  const resolved = prepareDestination({
    destination: rewrite.destination, params: { path: ["telemetry", "trusted"] },
    query: { date: "2026-09-06" }, appendParamsToQuery: true,
  });
  expect(resolved.parsedDestination.pathname).toBe("/api/index.py");
  expect(resolved.parsedDestination.query.__telemetry_path).toBe("telemetry/trusted");
  expect(resolved.parsedDestination.query.date).toBe("2026-09-06");
});

it("local rewrite still honors the configured uvicorn port and strips trailing slash", async () => {
  vi.stubEnv("VERCEL", ""); vi.stubEnv("BACKEND_URL", "http://127.0.0.1:8001/");
  vi.resetModules();
  const { default: config } = await import("../../next.config.mjs");
  expect((await config.rewrites())[0].destination).toBe("http://127.0.0.1:8001/api/:path*");
});
