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

  const caller = await authorizeRequest(req);
  if (!caller) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const typeFilter = searchParams.get("type") || "all";
  const categoryFilter = searchParams.get("category");

  try {
    const supabase = getSupabaseAdmin();
    let posts: any[] = [];
    let blogPosts: any[] = [];

    // 1. Fetch social posts
    if (typeFilter === "all" || typeFilter === "social") {
      let query = supabase
        .from("social_posts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (caller.kind === "user") {
        query = query.or(`user_id.eq.${caller.userId},user_id.is.null`);
      }

      const { data: rows, error } = await query;
      if (error) {
        console.error("Supabase error fetching social posts:", error);
      } else {
        posts = (rows || []).map((row: any) => ({
          id: row.id,
          created_at: row.created_at,
          title: row.title,
          twitter: row.twitter ?? "",
          instagram: row.instagram ?? "",
          facebook: row.facebook ?? "",
          youtube: row.youtube ?? "",
          linkedin: row.linkedin ?? "",
          instagram_data: row.instagram_data ?? null,
          facebook_data: row.facebook_data ?? null,
          youtube_data: row.youtube_data ?? null,
          linkedin_data: row.linkedin_data ?? null,
          twitter_data: row.twitter_data ?? null,
          sources: row.sources ?? [],
          image: row.has_image,
          image_url: row.image_url ?? null,
          published_to: row.published_to ?? {},
        }));
      }
    }

    // 2. Fetch blog posts (WordPress articles with category_hint)
    if (typeFilter === "all" || typeFilter === "blog") {
      try {
        let blogQuery = supabase
          .from("blog_posts")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);

        if (categoryFilter) {
          blogQuery = blogQuery.eq("category_hint", categoryFilter);
        }

        const { data: blogRows, error: blogErr } = await blogQuery;
        if (blogErr) {
          console.warn("Supabase error fetching blog_posts:", blogErr.message);
          // If query failed due to user_id filter, fallback to unfiltered
          const { data: fallbackRows } = await supabase
            .from("blog_posts")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(100);
          if (fallbackRows) {
            blogPosts = fallbackRows;
          }
        } else {
          blogPosts = blogRows || [];
        }
      } catch (e) {
        console.warn("Exception fetching blog posts:", e);
      }

      blogPosts = blogPosts.map((row: any) => ({
        id: row.id,
        created_at: row.created_at,
        title: row.title || "Untitled Article",
        slug: row.slug || "",
        content_md: row.content_md || "",
        excerpt: row.excerpt || "",
        focus_keyword: row.focus_keyword || "",
        meta_description: row.meta_description || "",
        category_hint: row.category_hint || "Uncategorized",
        has_image_1: row.has_image_1 ?? false,
        has_image_2: row.has_image_2 ?? false,
        image_1_url: row.image_1_url || null,
        image_2_url: row.image_2_url || null,
        wp_status: row.wp_status || "draft",
        wp_post_url: row.wp_post_url || null,
        wp_post_id: row.wp_post_id || null,
        wp_edit_url: row.wp_edit_url || null,
        user_id: row.user_id || null,
      }));
    }

    return NextResponse.json({
      success: true,
      posts,
      blog_posts: blogPosts,
      counts: {
        total: posts.length + blogPosts.length,
        social: posts.length,
        blog: blogPosts.length,
      },
    });
  } catch (err: any) {
    console.error("Posts API error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Unexpected error fetching posts." },
      { status: 500 }
    );
  }
}
