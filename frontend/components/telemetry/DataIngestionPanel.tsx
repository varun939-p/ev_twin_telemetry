"use client";

/**
 * DataIngestionPanel -- the manual door into the Data Layer.
 *
 * The automated feed is `GET /api/v1/vehicles` (see `telemetry/api.py`).  This
 * panel is the escape hatch for the case that feed does not cover: an operator
 * holding a raw capture on disk.  It POSTs the file to the *relative*
 * `/api/ingest/upload`, which `next.config.mjs` rewrites to the Python control
 * plane -- same-origin for the browser, so it works in a sandboxed preview and
 * behind a locked-down proxy without CORS.
 *
 * The panel owns no validation logic and no telemetry of its own.  The
 * extension gate mirrors the server's 415 purely to save a round trip; the
 * authority on what is accepted remains `telemetry.main.ingest_upload`, and
 * whatever it answers is surfaced verbatim.  A file landing here is *received*,
 * not trusted -- nothing renders until it has been through
 * `telemetry.schemas.parse_payload`.
 */

import { useCallback, useRef, useState } from "react";

const ENDPOINT = "/api/ingest/upload";

/** Mirrors the server's accept list; the server is still the authority. */
const ACCEPTED_EXTENSIONS = ["csv", "json"] as const;

/* ------------------------------------------------------------------ style */

const CARD = "rounded-2xl border border-white/[0.06] bg-slate-900/40 backdrop-blur-md";
const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.24em] text-slate-500";
const HAIRLINE = "h-px bg-white/[0.06]";

type Phase = "idle" | "ready" | "uploading" | "ok" | "error";

interface Result {
  ok: boolean;
  message: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function isAccepted(name: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value.toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

/* ----------------------------------------------------------------- panel */

export default function DataIngestionPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Client-side gate: reject anything the server would 415 anyway. */
  const accept = useCallback((next: File | null) => {
    setResult(null);
    if (!next) {
      setFile(null);
      setPhase("idle");
      return;
    }
    setFile(next);
    const accepted = isAccepted(next.name);
    setPhase(accepted ? "ready" : "error");
    if (!accepted) {
      setResult({ ok: false, message: `Only ${ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(" or ")} telemetry files are accepted.` });
    }
  }, []);

  const upload = useCallback(async () => {
    if (!file || phase === "uploading") return;
    setPhase("uploading");
    setResult(null);

    const body = new FormData();
    body.append("file", file, file.name);

    try {
      const response = await fetch(ENDPOINT, { method: "POST", body });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string; detail?: string; bytes?: number }
        | null;

      if (!response.ok) {
        // 5xx means the rewrite never reached uvicorn; 4xx carries the server's
        // own explanation, which is more useful than a generic failure string.
        setPhase("error");
        setResult({
          ok: false,
          message:
            response.status >= 500
              ? `Backend unreachable (HTTP ${response.status}) — is uvicorn running on :8000?`
              : (payload?.detail ?? payload?.message ?? `Upload rejected (HTTP ${response.status}).`),
        });
        return;
      }

      setPhase("ok");
      setResult({ ok: true, message: payload?.message ?? `${file.name} received by the Data Layer.` });
    } catch {
      setPhase("error");
      setResult({ ok: false, message: "Backend unreachable — is `uvicorn telemetry.main:app` running on :8000?" });
    }
  }, [file, phase]);

  const clear = useCallback(() => {
    setFile(null);
    setPhase("idle");
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const extensionOk = file ? isAccepted(file.name) : false;

  return (
    <section className={CARD}>
      <header className="flex flex-wrap items-start justify-between gap-3 px-6 pb-4 pt-6">
        <div>
          <p className={EYEBROW}>Data Layer · Manual Ingestion</p>
          <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-white">Drop a raw telemetry capture</h2>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-slate-500">
            The live feed is polled from <code className="font-mono text-slate-400">/api/v1/vehicles</code>. Use this door for a
            capture held on disk. Files are received here and validated by{" "}
            <code className="font-mono text-slate-400">telemetry.schemas.parse_payload</code> — nothing renders until it passes.
          </p>
        </div>
        <span className="rounded-full border border-white/[0.08] px-2.5 py-0.5 font-mono text-[10px] text-slate-500">
          {ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(" · ")}
        </span>
      </header>

      <div className={HAIRLINE} />

      <div className="px-6 py-6">
        {/* ------------------------------------------------------------ dropzone */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Choose a telemetry file to upload"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            accept(event.dataTransfer.files?.[0] ?? null);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-10 text-center transition ${
            dragging
              ? "border-cyan-400/50 bg-cyan-400/[0.06]"
              : "border-white/[0.09] bg-black/25 hover:border-white/[0.16] hover:bg-black/35"
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 text-slate-600" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V4.5m0 0L7.5 9M12 4.5l4.5 4.5M4.5 16.5v1.25A2.25 2.25 0 006.75 20h10.5a2.25 2.25 0 002.25-2.25V16.5" />
          </svg>
          <p className="mt-3 text-sm font-medium text-slate-300">Drag a file here, or click to browse</p>
          <p className="mt-1 text-[11px] text-slate-600">Accepted: .csv, .json · validated server-side before it reaches the dashboard</p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.json"
            className="hidden"
            onChange={(event) => accept(event.target.files?.[0] ?? null)}
          />
        </div>

        {/* ------------------------------------------------------- staged file */}
        {file && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-black/25 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-mono text-[12px] text-slate-200">{file.name}</p>
              <p className="mt-0.5 text-[10px] tabular-nums text-slate-600">
                {formatBytes(file.size)} · .{extensionOf(file.name) || "unknown"}
                {extensionOk ? "" : " · not an accepted type"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={upload}
                disabled={!extensionOk || phase === "uploading"}
                className="rounded-lg bg-cyan-400/90 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {phase === "uploading" ? "Uploading…" : "Send to Data Layer"}
              </button>
              <button
                type="button"
                onClick={clear}
                className="rounded-lg border border-white/[0.08] px-3 py-2 text-xs text-slate-400 transition hover:border-white/[0.16] hover:text-slate-200"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------- result */}
        <p aria-live="polite" className="mt-3 min-h-[1rem] text-[11px] leading-relaxed">
          {phase === "uploading" && <span className="text-slate-500">Transmitting to the control plane…</span>}
          {result && (
            <span className={result.ok ? "text-emerald-400/90" : "text-amber-400/90"}>{result.message}</span>
          )}
        </p>
      </div>
    </section>
  );
}
