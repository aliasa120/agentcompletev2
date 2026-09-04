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
        if (body.image_url !== undefined) {
            patch.image_url = body.image_url;
            patch.has_image = Boolean(body.image_url);
        }
        if (body.instagram_data !== undefined) patch.instagram_data = body.instagram_data;
        if (body.facebook_data !== undefined) patch.facebook_data = body.facebook_data;
        if (body.youtube_data !== undefined) patch.youtube_data = body.youtube_data;
        if (body.linkedin_data !== undefined) patch.linkedin_data = body.linkedin_data;
        if (body.twitter_data !== undefined) patch.twitter_data = body.twitter_data;

        const { data, error } = await supabase
            .from("social_posts")
            .update(patch)
            .eq("id", id)
            .select()
            .single();

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 502 });
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

        return NextResponse.json({ success: true, post: data });
    } catch (err: any) {
        console.error("Patch API error:", err);
        return NextResponse.json(
            { success: false, error: err.message || "Unexpected error updating post." },
            { status: 500 }
        );
    }
}
