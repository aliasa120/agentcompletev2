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



// GET /api/agents — list all agents with tool assignments
export async function GET() {

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  try {
    const { data: agents, error } = await supabase
      .from("agent_configs")
      .select(`
        *,
        workflow_agent_assignments (
          workflow_id
        ),
        agent_tool_assignments (
          id,
          tool_type,
          tool_key,
          tool_label,
          enabled,
          loading_mode,
          parameter_bindings
        )
      `)
      .order("sort_order", { ascending: true });

    if (error) throw error;
    return NextResponse.json({ agents: agents ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/agents — create new agent
export async function POST(req: Request) {

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  try {
    const body = await req.json();
    const { name, agent_type, description, system_prompt, model_key, sort_order, provider, model, workflow_id, workflow_ids } = body;

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const { data: agent, error } = await supabase
      .from("agent_configs")
      .insert({
        user_id: user.id,
        name,
        agent_type: agent_type ?? "subagent",
        description: description ?? "",
        system_prompt: system_prompt ?? "",
        model_key: model_key ?? "main_agent",
        provider: provider ?? "vercel",
        model: model ?? "xiaomi/mimo-v2.5-pro",
        sort_order: sort_order ?? 99,
        workflow_id: workflow_id ?? (workflow_ids && workflow_ids.length > 0 ? workflow_ids[0] : null), // fallback legacy column support
        is_builtin: false,
        enabled: true,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    // Insert many-to-many workflow assignments
    const idsToAssign: string[] = workflow_ids || (workflow_id ? [workflow_id] : []);
    if (idsToAssign.length > 0) {
      const assignmentRows = idsToAssign.map((wId: string) => ({
        workflow_id: wId,
        agent_id: agent.id,
      }));
      const { error: assignError } = await supabase
        .from("workflow_agent_assignments")
        .insert(assignmentRows);
      if (assignError) throw assignError;
    }

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[agents] Failed to trigger agent reload:", reloadErr);
    }

    return NextResponse.json({ agent });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
