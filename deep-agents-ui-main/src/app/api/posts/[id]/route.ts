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

    // Deleting another user's post must not be possible from an open endpoint.
    const caller = await authorizeRequest(req);
    if (!caller) {
        return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    try {
        const supabase = getSupabaseAdmin();

        const { data: existing, error: fetchErr } = await supabase
            .from("social_posts")
            .select("id, user_id")
            .eq("id", id)
            .maybeSingle();

        if (fetchErr) {
            console.error("Supabase lookup error before delete:", fetchErr);
            return NextResponse.json(
                { success: false, error: "Failed to look up post." },
                { status: 502 }
            );
        }
        if (!existing) {
            return NextResponse.json({ success: false, error: "Post not found." }, { status: 404 });
        }
        // Legacy rows have no owner and stay deletable by any signed-in user.
        if (caller.kind === "user" && existing.user_id && existing.user_id !== caller.userId) {
            return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
        }

        const { error: delErr } = await supabase.from("social_posts").delete().eq("id", id);
        if (delErr) {
            console.error("Supabase delete error:", delErr);
            return NextResponse.json(
                { success: false, error: "Failed to delete post from database." },
                { status: 502 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (err) {
        console.error("Delete API error:", err);
        return NextResponse.json(
            { success: false, error: "Unexpected error deleting post." },
            { status: 500 }
        );
    }
}
