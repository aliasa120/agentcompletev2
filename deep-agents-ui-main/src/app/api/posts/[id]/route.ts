import { NextResponse } from "next/server";

const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
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

    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/social_posts?id=eq.${encodeURIComponent(id)}`,
            {
                method: "DELETE",
                headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                    "Content-Type": "application/json",
                    Prefer: "return=minimal",
                },
            }
        );

        if (!res.ok) {
            const err = await res.text();
            console.error("Supabase delete error:", err);
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
