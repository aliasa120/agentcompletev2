import type { NextConfig } from "next";
import { spawn } from "child_process";
import { join } from "path";
import http from "http";

// Auto-start 9Router for local development
if (process.env.NODE_ENV === "development" && !process.env.NEXT_IS_EXPORT) {
  const req = http.get("http://localhost:20128/dashboard", (res) => {
    console.log("[9Router] Gateway is already running.");
  });

  req.on("error", () => {
    console.log("[9Router] Gateway not detected. Starting 9Router dev server...");
    const nineRouterDir = join(process.cwd(), "..", "9router-master");
    const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
    
    try {
      const child = spawn(cmd, ["next", "dev", "--webpack", "--port", "20128"], {
        cwd: nineRouterDir,
        env: {
          ...process.env,
          PORT: "20128",
          NEXT_PUBLIC_BASE_URL: "http://localhost:20128"
        },
        stdio: "ignore",
        detached: true
      });
      child.unref();
      console.log("[9Router] 9Router spawned in background.");
    } catch (e: any) {
      console.error("[9Router] Failed to auto-start 9Router dev server:", e.message);
    }
  });
}

const nextConfig: any = {
  output: "standalone",
  typescript: {
    // Skip type checking during production builds to speed up deployment builds (e.g. in Docker)
    ignoreBuildErrors: true,
  },
  experimental: {
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;
