import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/**
 * POST /api/reload-agent
 *
 * Touches agent.py to trigger langgraph's hot-reload watcher.
 * langgraph dev watches for file changes and automatically reloads
 * the Python graph — picking up new provider/model from Supabase.
 *
 * This avoids needing to manually restart `langgraph dev` after
 * changing the AI model config in Agent Settings.
 */

// Resolve the repo root relative to this file's location
// deep-agents-ui-main/src/app/api/reload-agent/route.ts
//  → up 5 levels → repo root
const REPO_ROOT = path.resolve(process.cwd(), "..");
const AGENT_FILES = [
  path.join(REPO_ROOT, "agent.py"),
  path.join(REPO_ROOT, "feeder_agent", "agent.py"),
  path.join(REPO_ROOT, "research_agent", "tools", "analyze_images_gemini.py"),
];

export async function POST(request: NextRequest) {
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
      console.warn(`[reload-agent] Could not touch ${filePath}:`, err);
      missing.push(path.basename(filePath));
    }
  }

  console.log(`[reload-agent] Touched: ${touched.join(", ")} | Missing: ${missing.join(", ")}`);

  return NextResponse.json({
    success: touched.length > 0,
    touched,
    missing,
    message: touched.length > 0
      ? `Triggered langgraph reload for: ${touched.join(", ")}. Allow ~5 seconds for the server to reload.`
      : "No agent files found to touch.",
  });
}
