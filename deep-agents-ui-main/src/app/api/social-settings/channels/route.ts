import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase credentials not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function getAuthenticatedUser(): Promise<{ id: string } | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
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
    const { data: { user } } = await supabase.auth.getUser();
    if (user) return user;
  } catch {}

  // Fallback: look up user ID from active mcp_connections
  try {
    const admin = getSupabaseAdmin();
    const { data } = await admin
      .from("mcp_connections")
      .select("user_id")
      .not("user_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (data?.user_id) return { id: data.user_id };
  } catch {}

  return null;
}

async function getComposioApiKey(): Promise<string> {
  if (process.env.COMPOSIO_API_KEY) return process.env.COMPOSIO_API_KEY;
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "composio_api_key")
      .limit(1)
      .maybeSingle();
    return data?.value || "";
  } catch {
    return "";
  }
}

async function getComposioConnection(toolkitSlug: string): Promise<any | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("mcp_connections")
      .select("*")
      .eq("connection_type", "composio")
      .ilike("toolkit_slug", toolkitSlug)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

// GET: Fetch managed Facebook pages or YouTube channels from Composio
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const platform = searchParams.get("platform");
    const supabase = getSupabaseAdmin();
    const user = await getAuthenticatedUser();
    const userId = user?.id || "c017bdb6-5708-4a8e-ba7d-ebf476485c61";

    // 1. Get saved channel settings
    if (platform === "saved") {
      let query = supabase
        .from("agent_settings")
        .select("key, value")
        .in("key", ["fb_page_id", "fb_page_name", "yt_channel_id", "yt_channel_title"]);

      if (user?.id) {
        query = query.eq("user_id", user.id);
      }

      const { data: rows } = await query;

      const saved: Record<string, string> = {};
      for (const r of rows || []) {
        saved[r.key] = r.value;
      }
      return NextResponse.json({ success: true, saved });
    }

    const apiKey = await getComposioApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: "Composio API key not configured" }, { status: 400 });
    }

    // 2. Fetch Facebook Pages
    if (platform === "facebook") {
      const conn = await getComposioConnection("facebook");
      const connectedAccountId = conn?.composio_conn_id || undefined;
      const targetUserId = conn?.user_id || userId;

      const payload: Record<string, any> = {
        arguments: {},
      };
      if (connectedAccountId) {
        payload.connected_account_id = connectedAccountId;
      }
      payload.user_id = targetUserId;

      const res = await fetch("https://backend.composio.dev/api/v3.1/tools/execute/FACEBOOK_LIST_MANAGED_PAGES", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        return NextResponse.json(
          { error: json.error?.message || json.message || "Failed to fetch Facebook pages from Composio" },
          { status: res.status }
        );
      }

      // Parse Facebook pages
      const rawData = json.data?.data || json.data || json;
      const items = Array.isArray(rawData) ? rawData : (rawData.items || rawData.data || []);
      const pages = items.map((p: any) => ({
        id: String(p.id || ""),
        name: p.name || p.title || "Unnamed Page",
        category: p.category || "",
        access_token: p.access_token ? "exists" : undefined,
      })).filter((p: any) => Boolean(p.id));

      return NextResponse.json({ success: true, pages });
    }

    // 3. Fetch YouTube Channels
    if (platform === "youtube") {
      const conn = await getComposioConnection("youtube");
      const connectedAccountId = conn?.composio_conn_id || undefined;
      const targetUserId = conn?.user_id || userId;

      const payload: Record<string, any> = {
        arguments: {
          mine: true,
          part: "snippet,statistics",
        },
      };
      if (connectedAccountId) {
        payload.connected_account_id = connectedAccountId;
      }
      payload.user_id = targetUserId;

      const res = await fetch("https://backend.composio.dev/api/v3.1/tools/execute/YOUTUBE_LIST_CHANNELS", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        return NextResponse.json(
          { error: json.error?.message || json.message || "Failed to fetch YouTube channels from Composio" },
          { status: res.status }
        );
      }

      // Parse YouTube channels
      const rawData = json.data?.items || json.data?.data || json.items || [];
      const channels = rawData.map((c: any) => ({
        id: String(c.id || ""),
        title: c.snippet?.title || "My YouTube Channel",
        customUrl: c.snippet?.customUrl || "",
        thumbnail: c.snippet?.thumbnails?.default?.url || "",
        subscriberCount: c.statistics?.subscriberCount || "",
        videoCount: c.statistics?.videoCount || "",
      })).filter((c: any) => Boolean(c.id));

      return NextResponse.json({ success: true, channels });
    }

    return NextResponse.json({ error: "Invalid platform. Specify platform=facebook, platform=youtube, or platform=saved." }, { status: 400 });
  } catch (err: any) {
    console.error("[social-settings/channels GET] Error:", err);
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}

// POST: Save user's chosen Facebook Page or YouTube Channel to agent_settings
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const supabase = getSupabaseAdmin();
    const user = await getAuthenticatedUser();
    const userId = user?.id || "c017bdb6-5708-4a8e-ba7d-ebf476485c61";

    const allowedKeys = ["fb_page_id", "fb_page_name", "yt_channel_id", "yt_channel_title"];
    const updates: { user_id: string; key: string; value: string; updated_at: string }[] = [];

    for (const key of allowedKeys) {
      if (body[key] !== undefined) {
        updates.push({
          user_id: userId,
          key,
          value: String(body[key] || ""),
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "No valid settings provided" }, { status: 400 });
    }

    // Upsert into agent_settings with primary key (user_id, key)
    const { error } = await supabase.from("agent_settings").upsert(updates, {
      onConflict: "user_id,key",
    });

    if (error) throw error;

    return NextResponse.json({ success: true, message: "Channel settings saved successfully!" });
  } catch (err: any) {
    console.error("[social-settings/channels POST] Error:", err);
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}
