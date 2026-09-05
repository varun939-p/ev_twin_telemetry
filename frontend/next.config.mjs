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
    ];
  },
};

export default nextConfig;
