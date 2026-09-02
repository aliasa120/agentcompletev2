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


// Supabase client is initialized per-request using getSupabaseClient(cookieStore)

// GET /api/mcp/tool-settings?connection_id=xxx
// Returns all tool settings for a given connection
export async function GET(req: Request) {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  const { searchParams } = new URL(req.url);
  const connection_id = searchParams.get("connection_id");

  try {
    let query = supabase.from("mcp_tool_settings").select("*");
    if (connection_id) query = query.eq("connection_id", connection_id);
    const { data, error } = await query.order("tool_key", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ settings: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error", settings: [] },
      { status: 200 }
    );
  }
}

// POST /api/mcp/tool-settings — seed tools for a connection from mcp_connections.available_tools
// Body: { connection_id }
export async function POST(req: Request) {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  try {
    const { connection_id } = await req.json();
    if (!connection_id) {
      return NextResponse.json({ error: "connection_id required" }, { status: 400 });
    }

    // Fetch connection to get available_tools
    const { data: conn, error: connErr } = await supabase
      .from("mcp_connections").select("id, available_tools").eq("user_id", user.id)
      .eq("id", connection_id)
      .single();

    if (connErr || !conn) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const tools: { tool_key: string; tool_name: string }[] = conn.available_tools ?? [];

    if (tools.length === 0) {
      return NextResponse.json({ seeded: 0 });
    }

    // Upsert each tool — preserve existing enabled state on conflict
    const rows = tools.map((t) => ({
      connection_id,
      tool_key: t.tool_key,
      tool_name: t.tool_name ?? t.tool_key,
      enabled: true,
      loading_mode: "primary",
      permission_mode: "always_allow",
      parameter_bindings: {},
      updated_at: new Date().toISOString(),
    }));

    const { error: upsertErr } = await supabase
      .from("mcp_tool_settings")
      .upsert(rows, {
        onConflict: "connection_id,tool_key",
        ignoreDuplicates: true, // don't overwrite existing enabled state
      });

    if (upsertErr) throw upsertErr;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[mcp/tool-settings] Failed to trigger agent reload on seed:", reloadErr);
    }

    return NextResponse.json({ seeded: rows.length });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// PATCH /api/mcp/tool-settings — toggle a tool enabled/disabled or change loading_mode / permission_mode
// Body: { connection_id, tool_key, enabled, loading_mode, permission_mode, parameter_bindings }
export async function PATCH(req: Request) {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  try {
    const { connection_id, tool_key, enabled, loading_mode, permission_mode, parameter_bindings } = await req.json();
    if (!connection_id || !tool_key) {
      return NextResponse.json({ error: "connection_id and tool_key required" }, { status: 400 });
    }

    const updatePayload: Record<string, any> = { updated_at: new Date().toISOString() };
    if (enabled !== undefined) updatePayload.enabled = enabled;
    if (loading_mode !== undefined) updatePayload.loading_mode = loading_mode;
    if (permission_mode !== undefined) updatePayload.permission_mode = permission_mode;
    if (parameter_bindings !== undefined) updatePayload.parameter_bindings = parameter_bindings;

    const { data, error } = await supabase
      .from("mcp_tool_settings")
      .update(updatePayload)
      .eq("connection_id", connection_id)
      .eq("tool_key", tool_key)
      .select()
      .single();

    if (error) throw error;

    // Also sync to agent_settings for high-speed cache
    if (permission_mode !== undefined) {
      const { data: currentPerm } = await supabase.from("agent_settings").select("value").eq("key", "mcp_tools_permission_modes").single();
      const perms = currentPerm?.value ? (typeof currentPerm.value === "string" ? JSON.parse(currentPerm.value) : currentPerm.value) : {};
      perms[tool_key] = permission_mode;
      await supabase.from("agent_settings").upsert({ key: "mcp_tools_permission_modes", value: JSON.stringify(perms), updated_at: new Date().toISOString() }, { onConflict: "key" });
    }

    if (parameter_bindings !== undefined) {
      const { data: currentBind } = await supabase.from("agent_settings").select("value").eq("key", "mcp_tools_parameter_bindings").single();
      const binds = currentBind?.value ? (typeof currentBind.value === "string" ? JSON.parse(currentBind.value) : currentBind.value) : {};
      if (parameter_bindings === null || Object.keys(parameter_bindings).length === 0) {
        delete binds[tool_key];
      } else {
        binds[tool_key] = parameter_bindings;
      }
      await supabase.from("agent_settings").upsert({ key: "mcp_tools_parameter_bindings", value: JSON.stringify(binds), updated_at: new Date().toISOString() }, { onConflict: "key" });
    }

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[mcp/tool-settings] Failed to trigger agent reload on patch:", reloadErr);
    }

    return NextResponse.json({ setting: data });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// PUT /api/mcp/tool-settings — bulk update (enable all / disable all or change mode / permission)
// Body: { connection_id, enabled, loading_mode, permission_mode }
export async function PUT(req: Request) {
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  try {
    const { connection_id, enabled, loading_mode, permission_mode } = await req.json();
    if (!connection_id) {
      return NextResponse.json({ error: "connection_id required" }, { status: 400 });
    }

    const updatePayload: Record<string, any> = { updated_at: new Date().toISOString() };
    if (enabled !== undefined) updatePayload.enabled = enabled;
    if (loading_mode !== undefined) updatePayload.loading_mode = loading_mode;
    if (permission_mode !== undefined) updatePayload.permission_mode = permission_mode;

    const { data: updatedRows, error } = await supabase
      .from("mcp_tool_settings")
      .update(updatePayload)
      .eq("connection_id", connection_id)
      .select();

    if (error) throw error;

    // Sync all updated keys to agent_settings
    if (permission_mode !== undefined && updatedRows) {
      const { data: currentPerm } = await supabase.from("agent_settings").select("value").eq("key", "mcp_tools_permission_modes").single();
      const perms = currentPerm?.value ? (typeof currentPerm.value === "string" ? JSON.parse(currentPerm.value) : currentPerm.value) : {};
      updatedRows.forEach((r: any) => {
        perms[r.tool_key] = permission_mode;
      });
      await supabase.from("agent_settings").upsert({ key: "mcp_tools_permission_modes", value: JSON.stringify(perms), updated_at: new Date().toISOString() }, { onConflict: "key" });
    }

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[mcp/tool-settings] Failed to trigger agent reload on bulk update:", reloadErr);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
