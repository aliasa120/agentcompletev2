import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authorizeRequest } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

function getSupabaseAdmin() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase credentials not configured");
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

export async function GET(req: Request) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return NextResponse.json(
      { success: false, error: "Supabase credentials not configured." },
      { status: 503 }
    );
  }

  // This route reads with the service-role key, so it must authenticate and
  // scope results — otherwise it exposes every user's posts.
  const caller = await authorizeRequest(req);
  if (!caller) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from("social_posts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    // Signed-in users see their own posts plus legacy rows that predate user_id.
    if (caller.kind === "user") {
      query = query.or(`user_id.eq.${caller.userId},user_id.is.null`);
    }

    const { data: rows, error } = await query;

    if (error) {
      console.error("Supabase error fetching posts:", error);
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 502 }
      );
    }

    // Return all posts shaped for the UI
    const posts = (rows || []).map((row: any) => ({
      id: row.id,
      created_at: row.created_at,
      title: row.title,
      twitter: row.twitter ?? "",
      instagram: row.instagram ?? "",
      facebook: row.facebook ?? "",
      youtube: row.youtube ?? "",
      instagram_data: row.instagram_data ?? null,
      facebook_data: row.facebook_data ?? null,
      youtube_data: row.youtube_data ?? null,
      sources: row.sources ?? [],
      image: row.has_image,
      image_url: row.image_url ?? null,
      published_to: row.published_to ?? {},
    }));

    return NextResponse.json({ success: true, posts });
  } catch (err: any) {
    console.error("Posts API error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Unexpected error fetching posts." },
      { status: 500 }
    );
  }
}
