import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authorizeRequest } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

function getSupabaseAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Supabase credentials not configured");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function getWpSettings(userId?: string | null): Promise<{ siteUrl: string; username: string; appPassword: string }> {
  try {
    const supabase = getSupabaseAdmin();
    const { data: rows } = await supabase.from("agent_settings").select("key, value, user_id");
    const map: Record<string, string> = {};
    for (const row of rows || []) {
      if (!row.user_id) map[row.key] = row.value ?? "";
    }
    if (userId) {
      for (const row of rows || []) {
        if (row.user_id === userId) map[row.key] = row.value ?? "";
      }
    }
    return {
      siteUrl: (process.env.WP_SITE_URL || map.wp_site_url || "").trim().replace(/\/+$/, ""),
      username: (process.env.WP_USERNAME || map.wp_username || "").trim(),
      appPassword: (process.env.WP_APP_PASSWORD || map.wp_app_password || "").trim(),
    };
  } catch {
    return {
      siteUrl: (process.env.WP_SITE_URL || "").trim().replace(/\/+$/, ""),
      username: (process.env.WP_USERNAME || "").trim(),
      appPassword: (process.env.WP_APP_PASSWORD || "").trim(),
    };
  }
}

export async function GET(req: Request) {
  const caller = await authorizeRequest(req);
  if (!caller) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const userId = caller.kind === "user" ? caller.userId : null;
  const { siteUrl, username, appPassword } = await getWpSettings(userId);

  if (!siteUrl || !username || !appPassword) {
    return NextResponse.json({
      success: false,
      error: "WordPress credentials not configured in Settings → Posts Plugin.",
      categories: [],
    });
  }

  try {
    const authHeader = `Basic ${Buffer.from(`${username}:${appPassword}`).toString("base64")}`;
    const res = await fetch(`${siteUrl}/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc`, {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json({
        success: false,
        error: `WordPress API returned ${res.status}: ${errText.slice(0, 150)}`,
        categories: [],
      });
    }

    const data = await res.json();
    const categories = (Array.isArray(data) ? data : []).map((cat: any) => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      count: cat.count || 0,
      link: cat.link || `${siteUrl}/category/${cat.slug}/`,
    }));

    return NextResponse.json({ success: true, categories });
  } catch (err: any) {
    console.error("Failed to fetch WordPress categories:", err);
    return NextResponse.json({
      success: false,
      error: err.message || "Failed to reach WordPress REST API.",
      categories: [],
    });
  }
}
