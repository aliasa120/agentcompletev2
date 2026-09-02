import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { triggerAgentReload } from "@/lib/agent-reloader";

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

export async function GET() {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data: settingsRows } = await supabase
      .from("agent_settings")
      .select("key, value")
      .in("key", [
        "builtin_tools_permission_modes",
        "builtin_tools_parameter_bindings",
        "mcp_tools_permission_modes",
        "mcp_tools_parameter_bindings",
        "builtin_tools_loading_modes",
      ]);

    const result: Record<string, any> = {
      builtin_permissions: {},
      builtin_bindings: {},
      builtin_modes: {},
      mcp_permissions: {},
      mcp_bindings: {},
    };

    (settingsRows || []).forEach((row: any) => {
      try {
        const parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
        if (row.key === "builtin_tools_permission_modes") result.builtin_permissions = parsed;
        if (row.key === "builtin_tools_parameter_bindings") result.builtin_bindings = parsed;
        if (row.key === "builtin_tools_loading_modes") result.builtin_modes = parsed;
        if (row.key === "mcp_tools_permission_modes") result.mcp_permissions = parsed;
        if (row.key === "mcp_tools_parameter_bindings") result.mcp_bindings = parsed;
      } catch {}
    });

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { tool_key, tool_type = "builtin", permission_mode, parameter_bindings, loading_mode } = body;

    if (!tool_key) {
      return NextResponse.json({ error: "tool_key is required" }, { status: 400 });
    }

    const permKey = tool_type === "mcp" ? "mcp_tools_permission_modes" : "builtin_tools_permission_modes";
    const bindKey = tool_type === "mcp" ? "mcp_tools_parameter_bindings" : "builtin_tools_parameter_bindings";
    const modeKey = "builtin_tools_loading_modes";

    // 1. Update Permission Mode if provided
    if (permission_mode !== undefined) {
      let query = supabase.from("agent_settings").select("value").eq("key", permKey);
      if (user?.id) query = query.eq("user_id", user.id);
      const { data: currentPerm } = await query.maybeSingle();
      const perms = currentPerm?.value ? (typeof currentPerm.value === "string" ? JSON.parse(currentPerm.value) : currentPerm.value) : {};
      perms[tool_key] = permission_mode;
      await supabase
        .from("agent_settings")
        .upsert({
          key: permKey,
          value: JSON.stringify(perms),
          user_id: user.id,
          updated_at: new Date().toISOString()
        }, { onConflict: "key,user_id" });
      
      // Also update mcp_tool_settings table if MCP tool
      if (tool_type === "mcp") {
        await supabase
          .from("mcp_tool_settings")
          .update({ permission_mode, updated_at: new Date().toISOString() })
          .eq("tool_key", tool_key);
      }
    }

    // 2. Update Parameter Bindings if provided
    if (parameter_bindings !== undefined) {
      let query = supabase.from("agent_settings").select("value").eq("key", bindKey);
      if (user?.id) query = query.eq("user_id", user.id);
      const { data: currentBind } = await query.maybeSingle();
      const bindings = currentBind?.value ? (typeof currentBind.value === "string" ? JSON.parse(currentBind.value) : currentBind.value) : {};
      if (parameter_bindings === null || Object.keys(parameter_bindings).length === 0) {
        delete bindings[tool_key];
      } else {
        bindings[tool_key] = parameter_bindings;
      }
      await supabase
        .from("agent_settings")
        .upsert({
          key: bindKey,
          value: JSON.stringify(bindings),
          user_id: user.id,
          updated_at: new Date().toISOString()
        }, { onConflict: "key,user_id" });

      if (tool_type === "mcp") {
        await supabase
          .from("mcp_tool_settings")
          .update({ parameter_bindings, updated_at: new Date().toISOString() })
          .eq("tool_key", tool_key);
      }
    }

    // 3. Update Loading Mode if provided (for builtin tools)
    if (loading_mode !== undefined && tool_type === "builtin") {
      let query = supabase.from("agent_settings").select("value").eq("key", modeKey);
      if (user?.id) query = query.eq("user_id", user.id);
      const { data: currentMode } = await query.maybeSingle();
      const modes = currentMode?.value ? (typeof currentMode.value === "string" ? JSON.parse(currentMode.value) : currentMode.value) : {};
      modes[tool_key] = loading_mode;
      await supabase
        .from("agent_settings")
        .upsert({
          key: modeKey,
          value: JSON.stringify(modes),
          user_id: user.id,
          updated_at: new Date().toISOString()
        }, { onConflict: "key,user_id" });
    }

    try {
      triggerAgentReload();
    } catch {}

    return NextResponse.json({ success: true, tool_key, permission_mode, parameter_bindings });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/tools/permissions — bulk permission updates across an entire MCP server
export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { connection_id, permission_mode, tool_keys } = await req.json();
    if (!permission_mode) {
      return NextResponse.json({ error: "permission_mode required" }, { status: 400 });
    }

    // 1. Update MCP tool settings table for the entire connection
    if (connection_id) {
      await supabase
        .from("mcp_tool_settings")
        .update({ permission_mode, updated_at: new Date().toISOString() })
        .eq("connection_id", connection_id);
    }

    // 2. Update agent_settings JSON map
    let query = supabase.from("agent_settings").select("value").eq("key", "mcp_tools_permission_modes");
    if (user?.id) query = query.eq("user_id", user.id);
    const { data: currentPerm } = await query.maybeSingle();
    const perms = currentPerm?.value ? (typeof currentPerm.value === "string" ? JSON.parse(currentPerm.value) : currentPerm.value) : {};

    if (Array.isArray(tool_keys)) {
      tool_keys.forEach((k: string) => {
        perms[k] = permission_mode;
      });
    }

    await supabase
      .from("agent_settings")
      .upsert({
        key: "mcp_tools_permission_modes",
        value: JSON.stringify(perms),
        user_id: user.id,
        updated_at: new Date().toISOString()
      }, { onConflict: "key,user_id" });

    try {
      triggerAgentReload();
    } catch {}

    return NextResponse.json({ success: true, count: tool_keys?.length || "all" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
