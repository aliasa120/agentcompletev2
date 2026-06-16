import fs from "fs";
import path from "path";

// Resolve the repo root relative to process.cwd() (project root)
const REPO_ROOT = path.resolve(process.cwd(), "..");
const AGENT_FILES = [
  path.join(REPO_ROOT, "agent.py"),
  path.join(REPO_ROOT, "feeder_agent", "agent.py"),
  path.join(REPO_ROOT, "research_agent", "tools", "analyze_images_gemini.py"),
];

export function triggerAgentReload() {
  const now = new Date();
  const touched: string[] = [];
  const missing: string[] = [];

  // 1. Try local filesystem touch (works for local development)
  for (const filePath of AGENT_FILES) {
    try {
      if (fs.existsSync(filePath)) {
        fs.utimesSync(filePath, now, now);
        touched.push(path.basename(filePath));
      } else {
        missing.push(path.basename(filePath));
      }
    } catch (err) {
      console.warn(`[agent-reloader] Could not touch ${filePath}:`, err);
      missing.push(path.basename(filePath));
    }
  }

  // 2. HTTP POST to trigger reload on backend container
  // We deduce the reload URLs based on NEXT_PUBLIC_API_URL and Docker Compose network hostnames
  let reloadHost = "localhost";
  if (process.env.NEXT_PUBLIC_API_URL) {
    try {
      const parsed = new URL(process.env.NEXT_PUBLIC_API_URL);
      if (parsed.hostname && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        reloadHost = parsed.hostname;
      }
    } catch {}
  }

  const reloadUrls = [`http://${reloadHost}:8080/reload`];
  if (reloadHost !== "backend") {
    reloadUrls.push("http://backend:8080/reload");
  }

  for (const urlStr of reloadUrls) {
    try {
      console.log(`[agent-reloader] Triggering backend reload via HTTP POST: ${urlStr}`);
      fetch(urlStr, { method: "POST" })
        .then(async (res) => {
          if (res.ok) {
            console.log(`[agent-reloader] Backend reload HTTP request succeeded for ${urlStr}.`);
          } else {
            const text = await res.text().catch(() => "");
            console.warn(`[agent-reloader] Backend reload HTTP request failed for ${urlStr} (status ${res.status}): ${text}`);
          }
        })
        .catch((err: any) => {
          console.warn(`[agent-reloader] Backend reload HTTP request failed for ${urlStr}:`, err.message || err);
        });
    } catch (err: any) {
      console.warn(`[agent-reloader] Failed to send reload request to ${urlStr}:`, err.message || err);
    }
  }

  console.log(`[agent-reloader] Touched: ${touched.join(", ")} | Missing: ${missing.join(", ")}`);
  return { touched, missing };
}
