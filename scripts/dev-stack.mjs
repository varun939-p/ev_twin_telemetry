#!/usr/bin/env node
/**
 * dev-stack — start the ENTIRE telemetry pipeline with one command.
 *
 *   npm run dev:all
 *
 * WHY THIS EXISTS (the "Backend unreachable (HTTP 500)" root cause)
 * -----------------------------------------------------------------
 * The dashboard chain is four processes deep:
 *
 *   browser → Next.js (:3000) → uvicorn control plane (:8000) → PostgreSQL
 *                                                      ↖ polling worker → Blue Energy
 *
 * `npm run dev` only ever started the FIRST hop. With nothing on :8000 every
 * /api/* rewrite hit ECONNREFUSED, Next surfaced it as HTTP 500, and the UI
 * printed "Backend unreachable". This script owns all processes, waits for
 * each one to be genuinely ready, and tears them down together.
 *
 * MODES
 *   replay (default, no upstream credentials):
 *       boots a REAL local PostgreSQL, loads the REAL captured fleet from
 *       live_capture.json through the engine's own repository code (no
 *       synthetic data), and serves the dashboard from it. The journal labels
 *       every such cycle trigger="replay".
 *   live (API_SECRET_KEY + API_PASSCODE set in .env / environment):
 *       additionally starts the real polling worker (`python -m telemetry
 *       run`) which pulls the fleet straight from the vendor API.
 *
 * Set REPLAY_CAPTURE=false to disable the replay data load entirely.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import http from "node:http";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const isWin = process.platform === "win32";

/* ------------------------------------------------------------------ .env */

function parseDotenv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) out[m[1]] = v; // real environment wins
  }
  return out;
}

const fileEnv = parseDotenv(path.join(ROOT, ".env"));
const envOf = (k) => process.env[k]?.trim() || fileEnv[k]?.trim() || "";

/* -------------------------------------------------------------- children */

const children = [];
let shuttingDown = false;

function run(name, cmd, args, extraEnv = {}, color = "\x1b[36m") {
  const label = `\x1b[2m${color}[${name}]\x1b[0m `;
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    shell: isWin,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const pipe = (src) => {
    const rl = createInterface({ input: src });
    rl.on("line", (l) => process.stdout.write(label + l + "\n"));
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code, signal) => {
    if (!shuttingDown) process.stdout.write(label + `exited (${signal ?? code})\n`);
  });
  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n[stack] ${signal} — stopping ${children.length} process(es)…\n`);
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // pgserver's postmaster is a child of dev_postgres.py; SIGTERM cascades.
  setTimeout(() => process.exit(0), 800);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* best effort */
    }
  }
});

/* --------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

async function waitHealthy(url, what, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const body = await fetchJson(url);
    if (body && (body.status === "ok" || body.ok === true)) {
      process.stdout.write(`[stack] ✓ ${what} is healthy\n`);
      return true;
    }
    await sleep(700);
  }
  process.stdout.write(`[stack] ✗ ${what} did not become healthy within ${seconds}s\n`);
  return false;
}

function venvPython() {
  const bin = isWin ? path.join(".venv", "Scripts", "python.exe") : path.join(".venv", "bin", "python");
  return path.join(ROOT, bin);
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log("\x1b[1m[stack] EV digital twin — full pipeline boot\x1b[0m");

  // 0. Python environment (control plane + engine), per the repo's Makefile.
  if (!existsSync(venvPython())) {
    console.log("[stack] .venv missing — creating (one-time, `make setup` equivalent)…");
    const py = isWin ? "python" : "python3";
    run("setup", py, ["-m", "venv", ".venv"]);
    await sleep(2500);
    run("setup", venvPython(), ["-m", "pip", "install", "-q", "--upgrade", "pip"]);
    await sleep(1500);
    run("setup", venvPython(), ["-m", "pip", "install", "-q", "-r", "requirements.txt", "pgserver"]);
    console.log("[stack] waiting for dependency install… (subsequent boots skip this)");
    await sleep(45_000);
  }
  const py = venvPython();

  // 1. DATABASE — real local PostgreSQL unless DATABASE_URL points elsewhere.
  let dbUrl = envOf("DATABASE_URL");
  const isLocalDb = !dbUrl || dbUrl.includes(".pgdata") || dbUrl.includes("localhost:5432") || dbUrl.includes("127.0.0.1:5432");
  if (isLocalDb) {
    const pg = run("db", py, ["tools/dev_postgres.py", "--pgdata", ".pgdata"], {}, "\x1b[35m");
    dbUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("local PostgreSQL did not print a URL (90s)")), 90_000);
      pg.stdout.setEncoding("utf8");
      pg.stdout.once("data", (chunk) => {
        const line = chunk.split("\n")[0].trim();
        if (line.startsWith("postgresql")) {
          clearTimeout(timer);
          resolve(line);
        }
      });
      pg.on("exit", () => reject(new Error("dev_postgres exited before printing DATABASE_URL")));
    });
    console.log("[stack] ✓ local PostgreSQL is up (real server, data in .pgdata/)");
  } else {
    console.log("[stack] ✓ using configured DATABASE_URL (remote — Neon or staging)");
  }
  const dbEnv = { DATABASE_URL: dbUrl };

  // 2. DATA — replay the REAL captured fleet unless live credentials exist.
  //    WORKER=off skips the polling worker even when credentials are present —
  //    for firewalled dev machines where the upstream is unreachable anyway.
  const apiKey = envOf("API_SECRET_KEY");
  const apiPass = envOf("API_PASSCODE");
  const liveCreds = Boolean(apiKey && apiPass);
  const replayEnabled = envOf("REPLAY_CAPTURE").toLowerCase() !== "false";
  const workerOff = envOf("WORKER").toLowerCase() === "off";

  if (liveCreds && workerOff) {
    console.log("[stack] ⚠ WORKER=off — live polling disabled for this session (firewalled machine)");
  } else if (liveCreds) {
    console.log("[stack] ✓ upstream credentials present — LIVE polling mode");
    run("worker", py, ["-m", "telemetry", "run"], dbEnv, "\x1b[33m");
  } else {
    if (!replayEnabled) {
      console.log("[stack] ⚠ no upstream credentials and REPLAY_CAPTURE=false — the database will stay empty");
    } else {
      console.log("[stack] • no upstream credentials — replaying the REAL captured fleet (tools/replay_capture.py)");
      const r = run("replay", py, ["tools/replay_capture.py", "live_capture.json"], dbEnv, "\x1b[33m");
      await new Promise((resolve) => r.on("exit", () => resolve()));
    }
  }

  // 3+4. DASHBOARD FIRST, then the control plane. The dashboard binds its
  //    port in well under a second (both `next start` and `next dev`), while
  //    uvicorn takes a moment longer — spawning the UI first guarantees the
  //    sandbox preview registration (first port to listen) always aims at
  //    :3000, the presentation layer, never at the JSON control plane on
  //    :8000 (whose bare root is a 404 — the "blank preview" incident).
  //
  //    WEB_MODE=start serves the PRODUCTION build (`next build` must have run):
  //    an immutable module snapshot with zero on-demand recompilation. This is
  //    the deployment-real mode and it structurally eliminates the dev-only
  //    stale-chunk hydration splits (server module != client module) that a
  //    long-lived `next dev` session can produce after hot edits.
  const webPort = process.env.PORT || "3000";
  const webMode = process.env.WEB_MODE === "start" ? "start" : "dev";
  console.log(`[stack] ✓ starting dashboard (${webMode}) on :${webPort} — open http://localhost:${webPort}/digital-twin/truck-telemetry`);
  run("web", isWin ? "npm.cmd" : "npm", ["run", webMode], { ...dbEnv, PORT: webPort }, "\x1b[34m");

  // 3. CONTROL PLANE — the FastAPI app the dashboard's /api/* rewrites target.
  const apiPort = envOf("API_PORT") || "8000";
  run("api", py, ["-m", "uvicorn", "telemetry.main:app", "--host", "0.0.0.0", "--port", apiPort], dbEnv, "\x1b[32m");
  const apiUp = await waitHealthy(`http://127.0.0.1:${apiPort}/api/health`, `control plane :${apiPort}`, 60);
  if (!apiUp) {
    console.error("[stack] control plane failed to start — check [api] logs above");
    shutdown("SIGTERM");
    return;
  }

  console.log("\x1b[1m[stack] all processes owned by this command — Ctrl+C stops everything\x1b[0m");
  // Keep the orchestrator alive while children run.
  await new Promise(() => undefined);
}

main().catch((err) => {
  console.error("[stack] fatal:", err);
  shutdown("SIGTERM");
});
