import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
const refresh = router.refresh;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
import AutoIngestTrigger from "@/components/shell/AutoIngestTrigger";

function mount(enabled = true) {
  return render(<AutoIngestTrigger source="waiting" sourceNote={null} enabled={enabled} />);
}

beforeEach(() => { sessionStorage.clear(); refresh.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("local bootstrap", () => {
  it.each([
    [500, "text/plain", "Internal Server Error"],
    [502, "text/html", "<html>Bad gateway</html>"],
    [503, "application/json", "not actually json"],
  ])("handles proxy HTTP %s without a JSON.parse crash", async (status, type, body) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { status, headers: { "Content-Type": type } }));
    vi.stubGlobal("fetch", fetcher);
    mount();
    await screen.findByText(/Backend unreachable/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("reports network failures clearly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mount();
    await screen.findByText(/Backend unreachable/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not treat an auth rejection as successful ingestion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "not authorized" }, { status: 401 })));
    mount();
    await screen.findByText(/requires server authorization/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([409, 429])("handles HTTP %s without a retry storm", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ detail: "wait" }, { status }));
    vi.stubGlobal("fetch", fetcher);
    mount();
    await screen.findByText(/running or cooling down/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not call ingestion at all when production bootstrap is disabled", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    mount(false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("tolerates disabled sessionStorage and refreshes after a real cycle", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, summary: { accepted: 8 } })));
    mount();
    await screen.findByText(/Telemetry received/);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not claim data arrived when a cycle accepted zero vehicles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, summary: { accepted: 0 } })));
    mount();
    await screen.findByText(/accepted no vehicles/);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("rejects an HTML success page instead of saying data arrived", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } })));
    mount();
    await screen.findByText(/unexpected response/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("posts exactly once in React Strict Mode", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, summary: { accepted: 8 } }));
    vi.stubGlobal("fetch", fetcher);
    render(<StrictMode><AutoIngestTrigger source="waiting" sourceNote={null} enabled /></StrictMode>);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe("/api/ingest/run");
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });

  it("aborts an in-flight request on unmount", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const view = mount();
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});
