/** @type {import('next').NextConfig} */

/**
 * `/api/*` ROUTING — one deployment, two runtimes.
 *
 * The Python control plane (FastAPI, `api/index.py`) is built by Vercel as a
 * serverless function inside THIS project. On Vercel, every `/api/*` request
 * is rewritten onto that function; the destination carries the matched path
 * so the function's ASGI wrapper (api/index.py) can recover the original
 * route regardless of which path the platform hands it.
 *
 * Locally there is no Python function — the rewrite proxies to
 * `uvicorn telemetry.main:app` (default :8000, override with
 * TELEMETRY_PROXY_URL), so `npm run dev` behaves exactly like production,
 * including the browser never seeing a second origin.
 *
 * The credentials for the database and the vendor API live only in the
 * function's environment. The browser talks to `/api/*` on its own origin
 * and never needs any of them.
 */

const onVercel = process.env.VERCEL === "1";

const nextConfig = {
  reactStrictMode: true,

  async rewrites() {
    const backend =
      process.env.TELEMETRY_PROXY_URL ?? "http://127.0.0.1:8000";
    return [
      {
        source: "/api/:path*",
        destination: onVercel
          ? "/api/index.py/:path*" // the Python serverless function, same deployment
          : `${backend.replace(/\/+$/, "")}/api/:path*`, // local uvicorn
      },
    ];
  },

  /**
   * ROOT CAUSE OF THE "EVERYTHING IS DEAD" BUG.
   *
   * Next 16 refuses cross-origin requests to dev-only resources (`/_next/hmr`,
   * the dev runtime) unless the requesting host is allow-listed. When the app
   * is viewed through a proxied preview host — a sandbox URL, an ngrok tunnel,
   * a LAN IP, a review deployment — every one of those requests is blocked,
   * the client runtime never boots, and THE PAGE NEVER HYDRATES.
   *
   * The symptom is brutal to diagnose because nothing errors: the server HTML
   * is perfect, so the dashboard looks fine but no `onClick` fires, no
   * `useEffect` runs, and `next/dynamic` never resolves — which is exactly why
   * [Know More] was dead, the sidebar links did not route, and the Leaflet map
   * stayed a grey skeleton box. One blocked origin, three "separate" bugs.
   *
   * Development only; it has no effect on `next start`.
   */
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "*.e2b.app", // sandboxed preview hosts
    "*.local",
  ],

  /**
   * The 2026 refactor collapsed the old two-tab product (`/trucks`,
   * `/batteries`, `/` fleet twin) into the six `/digital-twin/*` routes.
   * These permanent redirects keep every bookmark, deck link and QR code from
   * the last demo cycle working instead of 404-ing in front of a client.
   */
  async redirects() {
    return [
      { source: "/trucks", destination: "/digital-twin/truck-telemetry", permanent: true },
      { source: "/batteries", destination: "/digital-twin/battery-tracking", permanent: true },
      { source: "/digital-twin", destination: "/digital-twin/central", permanent: false },

      /**
       * Swap Station, Chargers and DG were pulled out into a separate
       * workstream and their routes deleted. They are TEMPORARY redirects,
       * not permanent ones: those pages are coming back under the same paths,
       * and a 308 would be cached by browsers and proxies long after the real
       * routes ship.
       */
      { source: "/digital-twin/swap-station", destination: "/digital-twin/central", permanent: false },
      { source: "/digital-twin/chargers", destination: "/digital-twin/central", permanent: false },
      { source: "/digital-twin/dg", destination: "/digital-twin/central", permanent: false },
    ];
  },
};

export default nextConfig;
