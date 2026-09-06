import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-host": "fleet.example.test", "x-forwarded-proto": "https" }) }));
import { loadTelemetry } from "@/lib/telemetry-source";

const doc = {
  generated_at: "2026-09-06T12:00:00Z",
  pipeline_health: { newest_observed_at: "2026-09-03T12:00:00Z" },
  vehicles: [{ vehicle_id: "TRUCK01", observed_at: "2026-09-03T12:00:00Z", values: { soc: 60 } }],
};
const ingestion = { state: "upstream_stale", detail: "Last poll succeeded; observations are old.", expected_interval_seconds: 300, last_attempt: null };

beforeEach(() => {
  vi.stubEnv("VERCEL", ""); vi.stubEnv("BACKEND_URL", "http://127.0.0.1:8001"); vi.stubEnv("TELEMETRY_API_URL", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("passes uncached, durable ingestion evidence alongside a connected document", async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { status: "ok", database: "up", ingestion } : doc));
  vi.stubGlobal("fetch", fetcher);
  const result = await loadTelemetry();
  expect(result.source).toBe("live");
  expect(result.ingestion?.state).toBe("upstream_stale");
  const probe = fetcher.mock.calls.find(([url]) => url.endsWith("/health"));
  expect(probe?.[0]).toBe("http://127.0.0.1:8001/api/health");
});

it("does not call a 200 health response live when its database is down", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { status: "ok", database: "down" } : doc)));
  const result = await loadTelemetry();
  expect(result.source).toBe("cached");
  expect(result.ingestion?.state).toBe("database_unreachable");
});

it("labels retained data cached when the uncached probe fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/health")) throw new TypeError("fetch failed");
    return Response.json(doc);
  }));
  const result = await loadTelemetry();
  expect(result.doc.vehicles).toHaveLength(1);
  expect(result.source).toBe("cached");
  expect(result.ingestion?.state).toBe("backend_unreachable");
});

it("handles plain-text proxy errors on both read endpoints", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Internal Server Error", { status: 500 })));
  const result = await loadTelemetry();
  expect(result.source).toBe("waiting");
  expect(result.doc.vehicles).toHaveLength(0);
  expect(result.ingestion?.state).toBe("backend_unreachable");
});

it("ignores a copied local BACKEND_URL on Vercel and uses the forwarded origin", async () => {
  vi.stubEnv("VERCEL", "1");
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { status: "ok", database: "up", ingestion } : doc));
  vi.stubGlobal("fetch", fetcher);
  await loadTelemetry();
  expect(fetcher.mock.calls.every(([url]) => url.startsWith("https://fleet.example.test/api/"))).toBe(true);
});

it("honors an explicit standalone TELEMETRY_API_URL override", async () => {
  vi.stubEnv("VERCEL", "1"); vi.stubEnv("TELEMETRY_API_URL", "https://python.example.test/");
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { status: "ok", database: "up", ingestion } : doc));
  vi.stubGlobal("fetch", fetcher);
  await loadTelemetry();
  expect(fetcher.mock.calls.every(([url]) => url.startsWith("https://python.example.test/api/"))).toBe(true);
});
