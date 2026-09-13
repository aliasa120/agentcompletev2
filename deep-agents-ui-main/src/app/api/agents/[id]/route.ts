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
          } catch {
            // Cookies may be read-only in route handlers.
          }
        },
      },
    }
  );
}

import { triggerAgentReload } from "@/lib/agent-reloader";



type RouteParams = { params: Promise<{ id: string }> };

type ToolAssignmentInput = {
  tool_type: "builtin" | "skill" | "mcp";
  tool_key: string;
  tool_label?: string;
  enabled?: boolean;
  loading_mode?: "primary" | "normal" | "super" | null;
  permission_mode?: "always_allow" | "ask" | "deny" | null;
  parameter_bindings?: Record<string, unknown>;
};

const BUILTIN_TOOL_KEYS = new Set([
  "unified_search", "unified_extract", "youtube_transcript", "search_conversation_history",
  "add_memory", "replace_memory", "remove_memory", "honcho_profile", "honcho_search",
  "honcho_reasoning", "honcho_context", "honcho_conclude", "think_tool", "fetch_images_brave",
  "analyze_images_gemini", "create_post_image", "upload_to_storage", "read_skill", "list_skills",
  "manage_skill", "save_posts_to_supabase", "save_wordpress_post", "save_youtube_video",
  "save_instagram_post", "save_facebook_post", "save_linkedin_post", "save_twitter_post",
  "save_tiktok_post", "save_pinterest_post", "save_social_bundle", "get_wordpress_categories",
  "publish_to_wordpress", "list_tools", "load_tools", "call_tool", "cronjob", "omni_analyzer",
  "text_to_speech", "terminal", "add_to_desk",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// GET /api/agents/[id]
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
      .from("agent_configs")
      .select(`*, agent_tool_assignments(*), workflow_agent_assignments(workflow_id)`)
      .eq("id", id)
      .eq("user_id", user.id)
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

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  const { id } = await params;
  try {
    const body = await req.json();
    const { tool_keys, workflow_ids, workflow_id, ...agentFields } = body;

    const { data: ownedAgent, error: ownedAgentError } = await supabase
      .from("agent_configs")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (ownedAgentError) throw ownedAgentError;
    if (!ownedAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    let normalizedTools: ToolAssignmentInput[] | null = null;
    if (Array.isArray(tool_keys)) {
      normalizedTools = tool_keys.map((raw: unknown) => {
        if (!isPlainObject(raw)) throw new Error("Invalid tool assignment");
        const toolType = raw.tool_type;
        const toolKey = typeof raw.tool_key === "string" ? raw.tool_key.trim() : "";
        if (!(["builtin", "skill", "mcp"] as unknown[]).includes(toolType) || !toolKey) {
          throw new Error("Each tool assignment requires a valid tool_type and tool_key");
        }
        if (raw.loading_mode != null && !["primary", "normal", "super"].includes(String(raw.loading_mode))) {
          throw new Error(`Invalid loading mode for ${toolKey}`);
        }
        if (raw.permission_mode != null && !["always_allow", "ask", "deny"].includes(String(raw.permission_mode))) {
          throw new Error(`Invalid permission mode for ${toolKey}`);
        }
        if (raw.parameter_bindings != null && !isPlainObject(raw.parameter_bindings)) {
          throw new Error(`Invalid parameter bindings for ${toolKey}`);
        }
        return {
          tool_type: toolType as ToolAssignmentInput["tool_type"],
          tool_key: toolKey,
          tool_label: typeof raw.tool_label === "string" ? raw.tool_label : toolKey,
          enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
          loading_mode: raw.loading_mode == null ? null : raw.loading_mode as ToolAssignmentInput["loading_mode"],
          permission_mode: raw.permission_mode == null ? null : raw.permission_mode as ToolAssignmentInput["permission_mode"],
          parameter_bindings: (raw.parameter_bindings as Record<string, unknown> | undefined) ?? {},
        };
      });

      const uniqueKeys = new Set(normalizedTools.map((tool) => `${tool.tool_type}:${tool.tool_key}`));
      if (uniqueKeys.size !== normalizedTools.length) {
        return NextResponse.json({ error: "Duplicate tool assignments are not allowed" }, { status: 400 });
      }
      const unknownBuiltin = normalizedTools.find((tool) => tool.tool_type === "builtin" && !BUILTIN_TOOL_KEYS.has(tool.tool_key));
      if (unknownBuiltin) {
        return NextResponse.json({ error: `Unknown built-in tool: ${unknownBuiltin.tool_key}` }, { status: 400 });
      }

      const requestedSkills = normalizedTools.filter((tool) => tool.tool_type === "skill").map((tool) => tool.tool_key);
      if (requestedSkills.length > 0) {
        const { data: skills, error: skillsError } = await supabase
          .from("skills_library")
          .select("skill_key")
          .in("skill_key", requestedSkills);
        if (skillsError) throw skillsError;
        const available = new Set((skills ?? []).map((skill) => skill.skill_key));
        const missing = requestedSkills.find((key) => !available.has(key));
        if (missing) return NextResponse.json({ error: `Unknown skill: ${missing}` }, { status: 400 });
      }

      const requestedMcp = normalizedTools.filter((tool) => tool.tool_type === "mcp").map((tool) => tool.tool_key);
      if (requestedMcp.length > 0) {
        const { data: connections, error: connectionError } = await supabase
          .from("mcp_connections")
          .select("available_tools")
          .eq("user_id", user.id)
          .eq("status", "active");
        if (connectionError) throw connectionError;
        const available = new Set<string>();
        for (const connection of connections ?? []) {
          for (const tool of Array.isArray(connection.available_tools) ? connection.available_tools : []) {
            const key = typeof tool === "string" ? tool : tool?.tool_key;
            if (key) available.add(String(key));
          }
        }
        const missing = requestedMcp.find((key) => !available.has(key));
        if (missing) return NextResponse.json({ error: `Unavailable MCP tool: ${missing}` }, { status: 400 });
      }
    }

    const idsToAssign = workflow_ids || (workflow_id !== undefined ? (workflow_id ? [workflow_id] : []) : null);
    const allowedAgentFields = [
      "name", "description", "system_prompt", "model_key", "provider", "model",
      "enabled", "sort_order", "attach_all_skills", "avatar_url",
    ];
    const updatePayload: Record<string, unknown> = {};
    for (const field of allowedAgentFields) {
      if (Object.hasOwn(agentFields, field)) updatePayload[field] = agentFields[field];
    }
    if (idsToAssign !== null) {
      updatePayload.workflow_id = idsToAssign.length > 0 ? idsToAssign[0] : null;
    }

    // Update agent config
    const { data: agent, error: agentErr } = await supabase
      .from("agent_configs")
      .update({ ...updatePayload, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id)
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

    if (normalizedTools !== null) {
      const { error: replaceError } = await supabase.rpc("replace_agent_tool_assignments", {
        p_agent_id: id,
        p_assignments: normalizedTools,
      });
      if (replaceError) throw replaceError;
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

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  const { id } = await params;
  try {
    const { error } = await supabase
      .from("agent_configs")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
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
