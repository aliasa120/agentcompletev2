import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

let redisClient: Redis | null = null;

function getRedisClient(): Redis | null {
  if (redisClient === null) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      return null;
    }
    try {
      redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
      });
      redisClient.on("error", (err) => {
        console.warn("[Redis] ioredis connection error:", err.message);
      });
    } catch (e) {
      console.warn("[Redis] ioredis init failed:", e);
      redisClient = null;
    }
  }
  return redisClient;
}

// GET /api/agent-settings
export async function GET() {
  try {
    const { data, error } = await supabase.from("agent_settings").select("key,value");
    if (error) throw error;
    return NextResponse.json({ settings: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error", settings: [] },
      { status: 500 }
    );
  }
}

// POST /api/agent-settings
export async function POST(req: Request) {
  try {
    const { rows } = await req.json();
    if (!rows || !Array.isArray(rows)) {
      return NextResponse.json({ error: "Invalid rows parameter" }, { status: 400 });
    }

    // 1. Save to Supabase
    const { error } = await supabase.from("agent_settings").upsert(rows, { onConflict: "key" });
    if (error) throw error;

    // 2. Save to Redis Cache (seed/overwrite the entire settings dictionary)
    const redis = getRedisClient();
    if (redis) {
      try {
        const { data: allData } = await supabase.from("agent_settings").select("key,value");
        if (allData) {
          const dict: Record<string, string> = {};
          for (const row of allData) {
            dict[row.key] = row.value;
          }
          await redis.setex("agent_settings:all", 3600, JSON.stringify(dict));
          console.log("[Redis] Successfully updated settings cache.");
        }
      } catch (err: any) {
        console.warn("[Redis] Failed to cache settings in Redis:", err.message);
      }
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
