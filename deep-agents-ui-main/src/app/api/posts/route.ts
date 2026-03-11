import { NextResponse } from "next/server";

// Support both NEXT_PUBLIC_ prefixed and non-prefixed env vars
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

interface SupabasePost {
  id: string;
  created_at: string;
  title: string;
  twitter: string | null;
  instagram: string | null;
  facebook: string | null;
  sources: string[] | null;
  has_image: boolean;
  image_url: string | null;
  raw_markdown: string | null;
  published_to: Record<string, boolean> | null;
}

export async function GET() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("Missing Supabase env vars. SUPABASE_URL:", !!SUPABASE_URL, "KEY:", !!SUPABASE_ANON_KEY);
    return NextResponse.json(
      { success: false, error: "Supabase credentials not configured." },
      { status: 503 }
    );
  }

  try {
    // Fetch ALL posts, newest first (no limit — show everything)
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/social_posts?order=created_at.desc&limit=100`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("Supabase error:", err);
      return NextResponse.json(
        { success: false, error: "Failed to fetch from database." },
        { status: 502 }
      );
    }

    const rows: SupabasePost[] = await res.json();

    if (!rows || rows.length === 0) {
      return NextResponse.json(
        { success: false, error: "No posts yet. Run the agent with a news story first." },
        { status: 404 }
      );
    }

    // Return all posts shaped for the UI
    const posts = rows.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      title: row.title,
      twitter: row.twitter ?? "",
      instagram: row.instagram ?? "",
      facebook: row.facebook ?? "",
      sources: row.sources ?? [],
      image: row.has_image,
      image_url: row.image_url ?? null,
      published_to: row.published_to ?? {},
    }));

    return NextResponse.json({ success: true, posts });
  } catch (err) {
    console.error("Posts API error:", err);
    return NextResponse.json(
      { success: false, error: "Unexpected error fetching posts." },
      { status: 500 }
    );
  }
}
