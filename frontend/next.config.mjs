/** @type {import('next').NextConfig} */

/**
 * NO `/api/*` PROXY REWRITES — deliberately.
 *
 * This config used to rewrite `/api/provision-site` and
 * `/api/provisioned-sites` to `BACKEND_URL`, defaulting to
 * `http://127.0.0.1:8000`. Nothing in the app has called either since the
 * legacy provisioning UI was removed, and on Vercel they are a live hazard: a
 * serverless function cannot reach localhost, so those routes could only ever
 * return 502 in production — a deployment blocker that no local test would
 * ever surface.
 *
 * The dashboard reaches the control plane through `lib/telemetry-source.ts`
 * (server-side, `TELEMETRY_API_URL`, credentials never in the browser). If a
 * provisioning UI returns, it should use that same documented path rather
 * than a rewrite pinned to a loopback address.
 */

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
