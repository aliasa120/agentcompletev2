import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authorizeRequest } from "@/lib/api-auth";
import path from "path";

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

// Simple Markdown to WordPress-compatible HTML converter
function markdownToHtml(md: string): string {
  // Strip YAML frontmatter
  let cleanMd = md;
  if (cleanMd.startsWith("---")) {
    const end = cleanMd.indexOf("\n---", 3);
    if (end !== -1) {
      cleanMd = cleanMd.slice(end + 4).trim();
    }
  }

  const lines = cleanMd.split("\n");
  const htmlLines: string[] = [];
  let inList = false;

  const inline = (text: string) => {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Headings
    if (trimmed.startsWith("### ")) {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      htmlLines.push(`<h3>${inline(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith("## ")) {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      htmlLines.push(`<h2>${inline(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith("# ")) {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      htmlLines.push(`<h1>${inline(trimmed.slice(2))}</h1>`);
    } else if (trimmed === "---" || trimmed === "***") {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      htmlLines.push("<hr />");
    } else if (trimmed.startsWith("> ")) {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      htmlLines.push(`<blockquote><p>${inline(trimmed.slice(2))}</p></blockquote>`);
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (!inList) {
        htmlLines.push("<ul>");
        inList = true;
      }
      htmlLines.push(`<li>${inline(trimmed.slice(2))}</li>`);
    } else if (trimmed.startsWith("![")) {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      const m = trimmed.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (m) {
        const alt = m[1];
        const src = m[2];
        htmlLines.push(
          `<figure class="wp-block-image size-large" style="margin:1.5em auto;max-width:750px;">` +
          `<img src="${src}" alt="${alt}" style="max-width:100%;height:auto;border-radius:8px;" />` +
          (alt ? `<figcaption style="text-align:center;font-size:0.85em;color:#666;margin-top:0.4em;">${alt}</figcaption>` : "") +
          `</figure>`
        );
      }
    } else if (!trimmed) {
      if (inList) {
        htmlLines.push("</ul>");
        inList = false;
      }
    } else {
      if (inList) {
        htmlLines.push("</ul>");
        inList = false;
      }
      htmlLines.push(`<p>${inline(trimmed)}</p>`);
    }
  }

  if (inList) htmlLines.push("</ul>");
  return htmlLines.join("\n");
}

// Upload featured image to WordPress Media Library
async function uploadFeaturedImage(
  imageUrl: string,
  siteUrl: string,
  authHeader: string,
  postTitle: string
): Promise<number | null> {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let filename = path.basename(new URL(imageUrl).pathname) || "featured_image.jpg";
    if (!filename.includes(".")) filename += ".jpg";

    let contentType = "image/jpeg";
    if (filename.endsWith(".png")) contentType = "image/png";
    if (filename.endsWith(".webp")) contentType = "image/webp";

    const uploadRes = await fetch(`${siteUrl}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": contentType,
      },
      body: new Uint8Array(buffer),
    });

    if (uploadRes.ok) {
      const mediaData = await uploadRes.json();
      return mediaData.id || null;
    }
    return null;
  } catch (e) {
    console.warn("[wordpress_publish] featured image upload failed (non-fatal):", e);
    return null;
  }
}

// Resolve or create category on WordPress
async function resolveOrCreateCategory(
  categoryName: string,
  siteUrl: string,
  authHeader: string
): Promise<{ id: number; name: string; link: string } | null> {
  const target = (categoryName || "Uncategorized").trim();
  try {
    const catsRes = await fetch(`${siteUrl}/wp-json/wp/v2/categories?per_page=100`, {
      headers: { Authorization: authHeader },
    });

    if (catsRes.ok) {
      const cats = await catsRes.json();
      const lower = target.toLowerCase();

      // 1. Exact match
      for (const c of cats) {
        if (c.name.toLowerCase() === lower || c.slug.toLowerCase() === lower) {
          return { id: c.id, name: c.name, link: c.link };
        }
      }

      // 2. Partial match
      for (const c of cats) {
        if (c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase())) {
          return { id: c.id, name: c.name, link: c.link };
        }
      }

      // 3. Create category on WordPress
      const createRes = await fetch(`${siteUrl}/wp-json/wp/v2/categories`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: target }),
      });

      if (createRes.ok) {
        const newCat = await createRes.json();
        return { id: newCat.id, name: newCat.name, link: newCat.link };
      }

      // 4. Fallback to uncategorized if available
      for (const c of cats) {
        if (c.slug.toLowerCase() === "uncategorized") {
          return { id: c.id, name: c.name, link: c.link };
        }
      }
    }
  } catch (e) {
    console.warn("[wordpress_publish] category lookup note:", e);
  }
  return null;
}

export async function POST(req: Request) {
  const caller = await authorizeRequest(req);
  if (!caller) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { blog_post_id } = body;

  if (!blog_post_id) {
    return NextResponse.json({ success: false, error: "blog_post_id is required" }, { status: 400 });
  }

  const userId = caller.kind === "user" ? caller.userId : null;
  const { siteUrl, username, appPassword } = await getWpSettings(userId);

  if (!siteUrl || !username || !appPassword) {
    return NextResponse.json({
      success: false,
      error: "WordPress credentials missing. Configure them in Posts Settings.",
    }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data: blogPost, error: fetchErr } = await supabase
    .from("blog_posts")
    .select("*")
    .eq("id", blog_post_id)
    .single();

  if (fetchErr || !blogPost) {
    return NextResponse.json({ success: false, error: "Blog post not found." }, { status: 404 });
  }

  const authHeader = `Basic ${Buffer.from(`${username}:${appPassword}`).toString("base64")}`;

  try {
    // 1. Resolve Category
    const categoryInfo = await resolveOrCreateCategory(blogPost.category_hint, siteUrl, authHeader);
    const categoryIds = categoryInfo?.id ? [categoryInfo.id] : [];

    // 2. Upload Featured Image if present
    let featuredMediaId: number | null = null;
    if (blogPost.image_1_url) {
      featuredMediaId = await uploadFeaturedImage(blogPost.image_1_url, siteUrl, authHeader, blogPost.title);
    }

    // 3. Convert Markdown to HTML
    const contentHtml = markdownToHtml(blogPost.content_md || "");

    // 4. Create post on WordPress
    const postPayload: Record<string, any> = {
      title: blogPost.title,
      content: contentHtml,
      status: "publish",
      slug: blogPost.slug || undefined,
      excerpt: blogPost.excerpt || undefined,
    };

    if (categoryIds.length > 0) {
      postPayload.categories = categoryIds;
    }
    if (featuredMediaId) {
      postPayload.featured_media = featuredMediaId;
    }

    const wpRes = await fetch(`${siteUrl}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(postPayload),
    });

    if (!wpRes.ok) {
      const errText = await wpRes.text().catch(() => "");
      return NextResponse.json({
        success: false,
        error: `WordPress publishing failed (${wpRes.status}): ${errText.slice(0, 200)}`,
      }, { status: 502 });
    }

    const wpPost = await wpRes.json();
    const postUrl = wpPost.link || `${siteUrl}/?p=${wpPost.id}`;
    const editUrl = `${siteUrl}/wp-admin/post.php?post=${wpPost.id}&action=edit`;

    // 5. Update blog_posts row in Supabase
    await supabase
      .from("blog_posts")
      .update({
        wp_status: "publish",
        wp_post_url: postUrl,
        wp_post_id: wpPost.id,
        wp_edit_url: editUrl,
        category_hint: categoryInfo?.name || blogPost.category_hint,
      })
      .eq("id", blog_post_id);

    return NextResponse.json({
      success: true,
      post_id: wpPost.id,
      post_url: postUrl,
      edit_url: editUrl,
      category: categoryInfo,
    });
  } catch (err: any) {
    console.error("WordPress publish error:", err);
    return NextResponse.json({
      success: false,
      error: err.message || "Failed to publish post to WordPress.",
    }, { status: 500 });
  }
}
