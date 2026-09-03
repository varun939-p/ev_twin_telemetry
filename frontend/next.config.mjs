/** @type {import('next').NextConfig} */

/**
 * The dashboard POSTs to the *relative* path `/api/provision-site`.  Rewriting
 * it to the Python control plane keeps the browser on a same-origin request --
 * the proxy hop is server-to-server, so the sandboxed preview (and any locked
 * down corporate browser) never needs to reach `127.0.0.1` or pass CORS.
 *
 * Point `BACKEND_URL` at wherever `uvicorn backend.main:app` runs.
 */
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/provision-site", destination: `${BACKEND_URL}/api/provision-site` },
      { source: "/api/provisioned-sites", destination: `${BACKEND_URL}/api/provisioned-sites` },
      { source: "/api/ingest/upload", destination: `${BACKEND_URL}/api/ingest/upload` },
    ];
  },
};

export default nextConfig;
