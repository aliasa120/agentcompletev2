import type { NextConfig } from "next";

const nextConfig: any = {
  output: "standalone",
  typescript: {
    // Skip type checking during production builds to speed up deployment builds (e.g. in Docker)
    ignoreBuildErrors: true,
  },
  eslint: {
    // Skip linting during production builds to speed up deployment builds
    ignoreDuringBuilds: true,
  },
  experimental: {
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;
