import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { triggerAgentReload } from "@/lib/agent-reloader";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/agents — list all agents with tool assignments
export async function GET() {
  try {
    const { data: agents, error } = await supabase
      .from("agent_configs")
      .select(`
        *,
        agent_tool_assignments (
          id,
          tool_type,
          tool_key,
          tool_label,
          enabled
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
  try {
    const body = await req.json();
    const { name, agent_type, description, system_prompt, model_key, sort_order, provider, model, workflow_id } = body;

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("agent_configs")
      .insert({
        name,
        agent_type: agent_type ?? "subagent",
        description: description ?? "",
        system_prompt: system_prompt ?? "",
        model_key: model_key ?? "main_agent",
        provider: provider ?? "vercel",
        model: model ?? "xiaomi/mimo-v2.5-pro",
        sort_order: sort_order ?? 99,
        workflow_id: workflow_id ?? null,
        is_builtin: false,
        enabled: true,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[agents] Failed to trigger agent reload:", reloadErr);
    }

    return NextResponse.json({ agent: data });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
