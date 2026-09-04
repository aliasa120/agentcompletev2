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

export async function GET(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const agent_id = searchParams.get("agent_id");
  if (!agent_id) return NextResponse.json({ error: "agent_id required" }, { status: 400 });

  try {
    const { data, error } = await supabase
      .from("agent_design_folders")
      .select("id, folder_id, design_folders(*)")
      .eq("agent_id", agent_id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ folders: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ folders: [], error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

import { triggerAgentReload } from "@/lib/agent-reloader";

export async function POST(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { agent_id, folder_id } = await req.json();
    if (!agent_id || !folder_id) return NextResponse.json({ error: "agent_id and folder_id required" }, { status: 400 });

    const { data, error } = await supabase
      .from("agent_design_folders")
      .upsert({ agent_id, folder_id }, { onConflict: "agent_id,folder_id" })
      .select()
      .single();
    if (error) throw error;
    try { triggerAgentReload(); } catch {}
    return NextResponse.json({ success: true, attachment: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { agent_id, folder_id } = await req.json();
    if (!agent_id || !folder_id) return NextResponse.json({ error: "agent_id and folder_id required" }, { status: 400 });

    const { error } = await supabase
      .from("agent_design_folders")
      .delete()
      .eq("agent_id", agent_id)
      .eq("folder_id", folder_id);
    if (error) throw error;
    try { triggerAgentReload(); } catch {}
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
