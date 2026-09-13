import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authorizeRequest } from "@/lib/api-auth";

const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

function getSupabaseAdmin() {
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function extractStashedField(rawMarkdown: string | null | undefined, fieldName: string): any {
    if (!rawMarkdown) return null;
    const regex = new RegExp(`<!--\\s*STASHED_${fieldName.toUpperCase()}:\\s*([\\s\\S]*?)\\s*-->`);
    const match = rawMarkdown.match(regex);
    if (!match) return null;
    try {
        return JSON.parse(match[1]);
    } catch {
        return match[1];
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const postType = searchParams.get("type") || "social";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return NextResponse.json(
            { success: false, error: "Supabase credentials not configured." },
            { status: 503 }
        );
    }

    if (!id) {
        return NextResponse.json(
            { success: false, error: "Post ID is required." },
            { status: 400 }
        );
    }

    const caller = await authorizeRequest(req);
    if (!caller) {
        return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    try {
        const supabase = getSupabaseAdmin();

        if (postType === "blog") {
            const { data: existing, error: fetchErr } = await supabase
                .from("blog_posts")
                .select("id")
                .eq("id", id)
                .maybeSingle();

            if (fetchErr) {
                return NextResponse.json({ success: false, error: fetchErr.message }, { status: 502 });
            }
            if (!existing) {
                return NextResponse.json({ success: false, error: "Blog post not found." }, { status: 404 });
            }

            const { error: delErr } = await supabase.from("blog_posts").delete().eq("id", id);
            if (delErr) {
                return NextResponse.json({ success: false, error: delErr.message }, { status: 502 });
            }
            return NextResponse.json({ success: true });
        }

        // Social Post
        const { data: existing, error: fetchErr } = await supabase
            .from("social_posts")
            .select("id, user_id")
            .eq("id", id)
            .maybeSingle();

        if (fetchErr) {
            return NextResponse.json({ success: false, error: "Failed to look up post." }, { status: 502 });
        }
        if (!existing) {
            // Also check blog_posts in case client didn't pass type
            const { data: maybeBlog } = await supabase.from("blog_posts").select("id").eq("id", id).maybeSingle();
            if (maybeBlog) {
                await supabase.from("blog_posts").delete().eq("id", id);
                return NextResponse.json({ success: true });
            }
            return NextResponse.json({ success: false, error: "Post not found." }, { status: 404 });
        }

        if (caller.kind === "user" && existing.user_id && existing.user_id !== caller.userId) {
            return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
        }

        // Delete associated draft rows in platform tables
        await Promise.allSettled([
            supabase.from("social_instagram_posts").delete().eq("post_id", id),
            supabase.from("social_facebook_posts").delete().eq("post_id", id),
            supabase.from("social_youtube_posts").delete().eq("post_id", id),
            supabase.from("social_linkedin_posts").delete().eq("post_id", id),
            supabase.from("social_twitter_posts").delete().eq("post_id", id),
            supabase.from("social_tiktok_posts").delete().eq("post_id", id),
            supabase.from("social_pinterest_posts").delete().eq("post_id", id),
        ]);

        const { error: delErr } = await supabase.from("social_posts").delete().eq("id", id);
        if (delErr) {
            return NextResponse.json({ success: false, error: delErr.message }, { status: 502 });
        }

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error("Delete API error:", err);
        return NextResponse.json(
            { success: false, error: err.message || "Unexpected error deleting post." },
            { status: 500 }
        );
    }
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const postType = searchParams.get("type") || "social";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return NextResponse.json(
            { success: false, error: "Supabase credentials not configured." },
            { status: 503 }
        );
    }

    if (!id) {
        return NextResponse.json({ success: false, error: "Post ID is required." }, { status: 400 });
    }

    const caller = await authorizeRequest(req);
    if (!caller) {
        return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));

    try {
        const supabase = getSupabaseAdmin();

        if (postType === "blog") {
            const patch: Record<string, any> = {};
            if (body.title !== undefined) patch.title = body.title;
            if (body.slug !== undefined) patch.slug = body.slug;
            if (body.content_md !== undefined) patch.content_md = body.content_md;
            if (body.excerpt !== undefined) patch.excerpt = body.excerpt;
            if (body.focus_keyword !== undefined) patch.focus_keyword = body.focus_keyword;
            if (body.meta_description !== undefined) patch.meta_description = body.meta_description;
            if (body.category_hint !== undefined) patch.category_hint = body.category_hint;
            if (body.image_1_url !== undefined) {
                patch.image_1_url = body.image_1_url;
                patch.has_image_1 = Boolean(body.image_1_url);
            }

            const { data, error } = await supabase
                .from("blog_posts")
                .update(patch)
                .eq("id", id)
                .select()
                .single();

            if (error) {
                return NextResponse.json({ success: false, error: error.message }, { status: 502 });
            }
            return NextResponse.json({ success: true, post: data });
        }

        // Social Post
        const patch: Record<string, any> = {};
        if (body.title !== undefined) patch.title = body.title;
        if (body.twitter !== undefined) patch.twitter = body.twitter;
        if (body.instagram !== undefined) patch.instagram = body.instagram;
        if (body.facebook !== undefined) patch.facebook = body.facebook;
        if (body.youtube !== undefined) patch.youtube = body.youtube;
        if (body.linkedin !== undefined) patch.linkedin = body.linkedin;
        if (body.tiktok !== undefined) patch.tiktok = body.tiktok;
        if (body.pinterest !== undefined) patch.pinterest = body.pinterest;
        if (body.image_url !== undefined) {
            patch.image_url = body.image_url;
            patch.has_image = Boolean(body.image_url);
        }
        if (body.instagram_data !== undefined) patch.instagram_data = body.instagram_data;
        if (body.facebook_data !== undefined) patch.facebook_data = body.facebook_data;
        if (body.youtube_data !== undefined) patch.youtube_data = body.youtube_data;
        if (body.linkedin_data !== undefined) patch.linkedin_data = body.linkedin_data;
        if (body.twitter_data !== undefined) patch.twitter_data = body.twitter_data;
        if (body.tiktok_data !== undefined) patch.tiktok_data = body.tiktok_data;
        if (body.pinterest_data !== undefined) patch.pinterest_data = body.pinterest_data;

        let currentPatch = { ...patch };
        let data: any = null;
        let lastError: any = null;

        // Try updating, defensively falling back to raw_markdown stashing if columns don't exist yet
        for (let attempt = 0; attempt < 5; attempt++) {
            const res = await supabase
                .from("social_posts")
                .update(currentPatch)
                .eq("id", id)
                .select()
                .single();

            if (!res.error) {
                data = res.data;
                lastError = null;
                break;
            }

            lastError = res.error;
            const errMsg = res.error.message || "";
            const match = errMsg.match(/Could not find the '([^']+)' column/);
            if (match && match[1]) {
                const missingCol = match[1];
                const omittedVal = currentPatch[missingCol];
                delete currentPatch[missingCol];

                if (omittedVal !== undefined) {
                    const { data: currentPost } = await supabase.from("social_posts").select("raw_markdown").eq("id", id).maybeSingle();
                    let raw = currentPost?.raw_markdown || "";
                    const markerRegex = new RegExp(`<!--\\s*STASHED_${missingCol.toUpperCase()}:[\\s\\S]*?-->`, "g");
                    raw = raw.replace(markerRegex, "").trim();
                    const newMarker = `\n<!-- STASHED_${missingCol.toUpperCase()}: ${JSON.stringify(omittedVal)} -->`;
                    currentPatch.raw_markdown = (raw + newMarker).trim();
                    continue;
                }
            }
            break;
        }

        if (lastError || !data) {
            return NextResponse.json({ success: false, error: lastError?.message || "Failed to update post" }, { status: 502 });
        }

        // Synchronize child platform tables if caption/message changed
        if (body.instagram !== undefined) {
            await supabase
                .from("social_instagram_posts")
                .update({ caption: body.instagram })
                .eq("post_id", id);
        }
        if (body.facebook !== undefined) {
            await supabase
                .from("social_facebook_posts")
                .update({ message: body.facebook })
                .eq("post_id", id);
        }
        if (body.youtube !== undefined) {
            await supabase
                .from("social_youtube_posts")
                .update({ description: body.youtube })
                .eq("post_id", id);
        }
        if (body.linkedin !== undefined) {
            await supabase
                .from("social_linkedin_posts")
                .update({ commentary: body.linkedin })
                .eq("post_id", id);
        }
        if (body.twitter !== undefined) {
            await supabase
                .from("social_twitter_posts")
                .update({ text: body.twitter })
                .eq("post_id", id);
        }
        if (body.tiktok !== undefined) {
            await supabase
                .from("social_tiktok_posts")
                .update({ text: body.tiktok })
                .eq("post_id", id);
        }
        if (body.pinterest !== undefined) {
            await supabase
                .from("social_pinterest_posts")
                .update({ description: body.pinterest })
                .eq("post_id", id);
        }

        // Un-stash fields on return data for client UI
        const raw = data.raw_markdown || "";
        data.tiktok = data.tiktok || extractStashedField(raw, "tiktok") || body.tiktok || "";
        data.tiktok_data = data.tiktok_data || extractStashedField(raw, "tiktok_data") || body.tiktok_data || null;
        data.pinterest = data.pinterest || extractStashedField(raw, "pinterest") || body.pinterest || "";
        data.pinterest_data = data.pinterest_data || extractStashedField(raw, "pinterest_data") || body.pinterest_data || null;

        return NextResponse.json({ success: true, post: data });
    } catch (err: any) {
        console.error("Patch API error:", err);
        return NextResponse.json(
            { success: false, error: err.message || "Unexpected error updating post." },
            { status: 500 }
        );
    }
}
