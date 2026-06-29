import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { triggerAgentReload } from "@/lib/agent-reloader";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/agents/[id]
export async function GET(_req: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const { data, error } = await supabase
      .from("agent_configs")
      .select(`*, agent_tool_assignments(*), workflow_agent_assignments(workflow_id)`)
      .eq("id", id)
      .single();
    if (error) throw error;
    return NextResponse.json({ agent: data });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// PATCH /api/agents/[id] — update agent + replace tool assignments
export async function PATCH(req: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const body = await req.json();
    const { tool_keys, workflow_ids, workflow_id, ...agentFields } = body;

    const idsToAssign = workflow_ids || (workflow_id !== undefined ? (workflow_id ? [workflow_id] : []) : null);
    const updatePayload: Record<string, any> = { ...agentFields };
    if (idsToAssign !== null) {
      updatePayload.workflow_id = idsToAssign.length > 0 ? idsToAssign[0] : null; // fallback legacy column support
    }

    // Update agent config
    const { data: agent, error: agentErr } = await supabase
      .from("agent_configs")
      .update({ ...updatePayload, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (agentErr) throw agentErr;

    // Replace workflow assignments if provided
    if (idsToAssign !== null) {
      const { error: delErr } = await supabase
        .from("workflow_agent_assignments")
        .delete()
        .eq("agent_id", id);
      if (delErr) throw delErr;

      if (idsToAssign.length > 0) {
        const assignmentRows = idsToAssign.map((wId: string) => ({
          workflow_id: wId,
          agent_id: id,
        }));
        const { error: insErr } = await supabase
          .from("workflow_agent_assignments")
          .insert(assignmentRows);
        if (insErr) throw insErr;
      }
    }

    // Replace tool assignments if provided
    if (Array.isArray(tool_keys)) {
      // Delete existing
      await supabase.from("agent_tool_assignments").delete().eq("agent_id", id);
      // Insert new
      if (tool_keys.length > 0) {
        const rows = tool_keys.map((t: { tool_type: string; tool_key: string; tool_label: string; loading_mode?: string; parameter_bindings?: any }) => ({
          agent_id: id,
          tool_type: t.tool_type,
          tool_key: t.tool_key,
          tool_label: t.tool_label ?? t.tool_key,
          enabled: true,
          loading_mode: t.loading_mode || "primary",
          parameter_bindings: t.parameter_bindings || {},
        }));
        await supabase.from("agent_tool_assignments").insert(rows);
      }
    }

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[agents] Failed to trigger agent reload on patch:", reloadErr);
    }

    return NextResponse.json({ agent, success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/agents/[id]
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const { error } = await supabase.from("agent_configs").delete().eq("id", id);
    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[agents] Failed to trigger agent reload on delete:", reloadErr);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
