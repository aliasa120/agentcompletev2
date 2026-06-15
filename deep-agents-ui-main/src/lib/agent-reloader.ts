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

  console.log(`[agent-reloader] Touched: ${touched.join(", ")} | Missing: ${missing.join(", ")}`);
  return { touched, missing };
}
