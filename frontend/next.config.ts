import type { NextConfig } from "next";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/provision-site", destination: `${BACKEND_URL}/api/provision-site` },
      { source: "/api/provisioned-sites", destination: `${BACKEND_URL}/api/provisioned-sites` },
    ];
  },
};

export default nextConfig;