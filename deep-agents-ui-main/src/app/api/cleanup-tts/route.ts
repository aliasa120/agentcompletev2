import { NextResponse } from "next/server";

/**
 * POST /api/cleanup-tts
 * Deletes TTS audio files older than 30 days from the Supabase uploads bucket.
 * Safe to call daily from a cron job or the Vercel Cron config.
 * Protected by CRON_SECRET (or skipped in dev).
 */
export async function POST(req: Request) {
  // Optional secret guard
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const backendUrl = process.env.LANGGRAPH_API_URL || "http://localhost:2024";
    const res = await fetch(`${backendUrl}/cleanup-tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: text }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json({ ok: true, ...data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ info: "POST to this endpoint to run TTS cleanup (deletes files older than 30 days)." });
}

