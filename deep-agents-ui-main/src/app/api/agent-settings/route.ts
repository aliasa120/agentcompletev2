import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function getSupabaseClient(cookieStore: any) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );
}

import Redis from "ioredis";



import fs from "fs";

let redisClient: Redis | null = null;

function getRedisClient(): Redis | null {
  if (redisClient === null) {
    let redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      return null;
    }
    
    // If running inside Docker and REDIS_URL is local, point to docker service name 'redis'
    if (fs.existsSync("/.dockerenv")) {
      if (redisUrl.includes("127.0.0.1") || redisUrl.includes("localhost")) {
        redisUrl = "redis://redis:6379";
      }
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

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  try {
    const { data, error } = await supabase.from("agent_settings").select("key,value").eq("user_id", user.id);
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

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  try {
    const { rows } = await req.json();
    if (!rows || !Array.isArray(rows)) {
      return NextResponse.json({ error: "Invalid rows parameter" }, { status: 400 });
    }

    // 1. Save to Supabase with user_id (deduplicated by key to prevent PostgreSQL ON CONFLICT batch errors)
    const uniqueMap = new Map<string, any>();
    for (const r of rows) {
      if (r && r.key) {
        uniqueMap.set(r.key, {
          user_id: user.id,
          key: r.key,
          value: r.value ?? "",
          updated_at: new Date().toISOString()
        });
      }
    }

    // Stamp auto_publish_since the moment auto-publish is switched ON.
    // cron_scheduler reads this key to bound its sweep; without it the first
    // tick would treat the entire social_posts history as publishable.
    const incomingAutoPublish = uniqueMap.get("social_auto_publish");
    if (incomingAutoPublish && String(incomingAutoPublish.value).toLowerCase() === "true") {
      const { data: prevRows } = await supabase
        .from("agent_settings")
        .select("key,value")
        .eq("user_id", user.id)
        .in("key", ["social_auto_publish", "auto_publish_since"]);
      const prev: Record<string, string> = {};
      for (const row of prevRows ?? []) prev[row.key] = row.value ?? "";

      const wasEnabled = (prev.social_auto_publish || "").toLowerCase() === "true";
      // Only stamp on the off -> on transition, or when the marker is missing,
      // and never overwrite a value the caller sent explicitly.
      if ((!wasEnabled || !prev.auto_publish_since) && !uniqueMap.has("auto_publish_since")) {
        uniqueMap.set("auto_publish_since", {
          user_id: user.id,
          key: "auto_publish_since",
          value: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }

    const rowsWithUser = Array.from(uniqueMap.values());
    const { error } = await supabase.from("agent_settings").upsert(rowsWithUser, { onConflict: "user_id,key" });
    if (error) throw error;

    // 2. Save to Redis Cache (seed/overwrite the user's settings dictionary)
    const redis = getRedisClient();
    if (redis) {
      try {
        const { data: allData } = await supabase.from("agent_settings").select("key,value").eq("user_id", user.id);
        if (allData) {
          const dict: Record<string, string> = {};
          for (const row of allData) {
            dict[row.key] = row.value;
          }
          await redis.setex(`agent_settings:${user.id}`, 3600, JSON.stringify(dict));
          await redis.del("agent_settings:all");
          console.log(`[Redis] Successfully updated settings cache for user ${user.id}.`);
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
