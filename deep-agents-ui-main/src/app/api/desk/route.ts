/**
 * /api/desk — the user's Desk (Add to Desk task inbox).
 *
 * GET   ?status=pending|executing|done|failed  → list task cards (newest first)
 * POST  → manual create (same payload the agent's add_to_desk tool sends)
 *
 * Cards are deposited by the agent via the `add_to_desk` tool; this route is
 * the read side for the Desk UI (Settings → Desk).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

function getSupabaseClient(cookieStore: any) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
          } catch {
            /* read-only cookie store in route handlers */
          }
        },
      },
    }
  );
}

const VALID_STATUSES = new Set(["pending", "executing", "done", "failed"]);

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);

    const status = req.nextUrl.searchParams.get("status");
    let query = supabase
      .from("desk_tasks")
      .select("*")
      .eq("user_id", user.id);
    if (status && VALID_STATUSES.has(status)) {
      query = query.eq("status", status);
    }
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    return NextResponse.json({ tasks: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(_req: NextRequest) {
  return NextResponse.json(
    { error: "Desk tasks must be created by the validated add_to_desk tool" },
    { status: 405, headers: { Allow: "GET" } }
  );
}
