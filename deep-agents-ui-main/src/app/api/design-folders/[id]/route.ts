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
          } catch { /* no-op */ }
        },
      },
    }
  );
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const { name, description, sort_order } = await req.json();
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = String(name).trim();
    if (description !== undefined) patch.description = String(description);
    if (sort_order !== undefined) patch.sort_order = Number(sort_order) || 0;

    const { data, error } = await supabase
      .from("design_folders")
      .update(patch)
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ folder: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const { error } = await supabase
      .from("design_folders")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
