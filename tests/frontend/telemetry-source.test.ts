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

it("falls back to default api paths when Vercel environment variables are empty strings", async () => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("TELEMETRY_DOC_PATH", "  ");
  vi.stubEnv("TELEMETRY_HEALTH_PATH", "");
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { status: "ok", database: "up", ingestion } : doc));
  vi.stubGlobal("fetch", fetcher);
  await loadTelemetry();
  expect(fetcher.mock.calls.some(([url]) => url === "https://fleet.example.test/api/health")).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => url === "https://fleet.example.test/api/telemetry/trusted")).toBe(true);
});

it("safely handles HTML error responses without unhandled SyntaxError", async () => {
  vi.stubEnv("VERCEL", "1");
  const fetcher = vi.fn(async () => new Response("<!DOCTYPE html><html>404</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  }));
  vi.stubGlobal("fetch", fetcher);
  const result = await loadTelemetry();
  expect(result.source).toBe("waiting");
  expect(result.note).toContain("non-JSON");
});


it("self-fetches through the production domain on Vercel production, not the SSO-protected deployment host", async () => {
  // The GitHub deployment status links to <project>-<hash>-<team>.vercel.app,
  // which Vercel's default Deployment Protection puts behind SSO. A server-side
  // probe to that host gets the login page, never JSON -> "Backend unreachable".
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "ev-twin-telemetry.vercel.app");
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { status: "ok", database: "up", ingestion } : doc));
  vi.stubGlobal("fetch", fetcher);
  const result = await loadTelemetry();
  expect(result.source).toBe("live");
  expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual([
    "https://ev-twin-telemetry.vercel.app/api/health",
    "https://ev-twin-telemetry.vercel.app/api/telemetry/trusted",
  ]);
});

it("keeps using the forwarded host for Vercel preview deployments", async () => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "ev-twin-telemetry.vercel.app");
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { status: "ok", database: "up", ingestion } : doc));
  vi.stubGlobal("fetch", fetcher);
  await loadTelemetry();
  expect(fetcher.mock.calls.every(([url]) => url.startsWith("https://fleet.example.test/api/"))).toBe(true);
});
