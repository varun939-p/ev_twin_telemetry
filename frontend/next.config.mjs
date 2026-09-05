/** @type {import('next').NextConfig} */

/**
 * The dashboard POSTs to *relative* paths under `/api/...`.  Rewriting them to
 * the Python control plane keeps the browser on a same-origin request — the
 * proxy hop is server-to-server, so a sandboxed preview (or a locked-down
 * corporate browser) never needs to reach `127.0.0.1` or pass CORS.
 *
 * Point `BACKEND_URL` at wherever `uvicorn telemetry.main:app` runs.
 */
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,

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

  async rewrites() {
    return [
      { source: "/api/provision-site", destination: `${BACKEND_URL}/api/provision-site` },
      { source: "/api/provisioned-sites", destination: `${BACKEND_URL}/api/provisioned-sites` },
    ];
  },

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
