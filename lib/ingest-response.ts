/** Never JSON.parse a proxy's plain-text "Internal Server Error" page. */
export async function readIngestResponse(response: Response): Promise<{ message: string; refresh: boolean }> {
  let payload: unknown = null;
  if (response.headers.get("content-type")?.includes("application/json")) {
    payload = await response.json().catch(() => null);
  }
  const data = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { message: "Ingestion requires server authorization. Waiting for the polling worker or cron; no secret is sent from this browser.", refresh: false };
    }
    if (response.status === 409 || response.status === 429) {
      return { message: "Ingestion is running or cooling down. The dashboard will refresh automatically.", refresh: false };
    }
    const detail = typeof data?.detail === "string" ? data.detail : null;
    return {
      message: detail ? `Could not fetch data: ${detail}` : `Backend unreachable (HTTP ${response.status}). Check that the control plane is running and the proxy target is correct.`,
      refresh: false,
    };
  }
  const summary = data?.summary;
  if (data?.ok !== true || typeof summary !== "object" || summary === null || !("accepted" in summary) || typeof summary.accepted !== "number") {
    return { message: "The backend returned an unexpected response. Check the ingestion status and server logs.", refresh: false };
  }
  if (summary.accepted === 0) {
    return { message: "The poll completed but accepted no vehicles. Check upstream data, date probes and validation in ingestion status.", refresh: true };
  }
  return {
    message: data.status === "partial" ? "The poll completed with gaps. Refreshing ingestion diagnostics…" : "Telemetry received. Refreshing dashboard…",
    refresh: true,
  };
}
