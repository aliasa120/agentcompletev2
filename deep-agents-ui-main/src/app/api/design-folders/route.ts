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

export async function GET() {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { data, error } = await supabase
      .from("design_folders")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ folders: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ folders: [], error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { name, description = "", sort_order = 0 } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: "Folder name is required" }, { status: 400 });

    const { data, error } = await supabase
      .from("design_folders")
      .insert({ user_id: user.id, name: name.trim(), description, sort_order })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ folder: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
