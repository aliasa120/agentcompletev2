import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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
          } catch {}
        },
      },
    }
  );
}

import { triggerAgentReload } from "@/lib/agent-reloader";



type RouteParams = { params: Promise<{ id: string }> };

// GET /api/workflows/[id]
export async function GET(_req: Request, { params }: RouteParams) {

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  const { id } = await params;
  try {
    const { data, error } = await supabase
      .from("workflows")
      .select("*")
      .eq("id", id)
      .single();
    if (error) throw error;
    return NextResponse.json({ workflow: data });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// PATCH /api/workflows/[id]
export async function PATCH(req: Request, { params }: RouteParams) {

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  const { id } = await params;
  try {
    const body = await req.json();

    const { data: workflow, error } = await supabase
      .from("workflows")
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[workflows] Failed to trigger agent reload on patch:", reloadErr);
    }

    return NextResponse.json({ workflow, success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/workflows/[id]
export async function DELETE(_req: Request, { params }: RouteParams) {

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  const { id } = await params;
  try {
    const { error } = await supabase.from("workflows").delete().eq("id", id);
    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[workflows] Failed to trigger agent reload on delete:", reloadErr);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
