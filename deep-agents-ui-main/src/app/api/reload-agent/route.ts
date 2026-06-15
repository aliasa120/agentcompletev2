import { NextRequest, NextResponse } from "next/server";
import { triggerAgentReload } from "@/lib/agent-reloader";

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
export async function POST(request: NextRequest) {
  const { touched, missing } = triggerAgentReload();

  return NextResponse.json({
    success: touched.length > 0,
    touched,
    missing,
    message: touched.length > 0
      ? `Triggered langgraph reload for: ${touched.join(", ")}. Allow ~5 seconds for the server to reload.`
      : "No agent files found to touch.",
  });
}
