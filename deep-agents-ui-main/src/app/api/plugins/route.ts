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
          } catch {
            // Ignore cookie-setting failures (e.g. in server components).
          }
        },
      },
    }
  );
}

// GET /api/plugins — returns the plugin catalog with the caller's enabled state.
export async function GET() {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data: pluginRows, error: pluginError } = await supabase
      .from("plugins")
      .select("*")
      .order("sort_order");
    if (pluginError) throw pluginError;

    const { data: stateRows, error: stateError } = await supabase
      .from("user_plugin_settings")
      .select("plugin_key, enabled")
      .eq("user_id", user.id);
    if (stateError) throw stateError;

    const stateMap: Record<string, boolean> = {};
    (stateRows || []).forEach((row: any) => {
      stateMap[row.plugin_key] = !!row.enabled;
    });

    const plugins = (pluginRows || []).map((p: any) => ({
      ...p,
      enabled:
        stateMap[p.plugin_key] !== undefined
          ? stateMap[p.plugin_key]
          : !!p.default_enabled,
    }));

    return NextResponse.json({ plugins });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PATCH /api/plugins — enable/disable a plugin for the current user.
export async function PATCH(req: NextRequest) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { plugin_key, enabled } = body;

    if (!plugin_key) {
      return NextResponse.json(
        { error: "plugin_key is required" },
        { status: 400 }
      );
    }
    if (typeof enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 }
      );
    }

    // Ensure the plugin exists in the catalog.
    const { data: pluginRow, error: pluginError } = await supabase
      .from("plugins")
      .select("plugin_key")
      .eq("plugin_key", plugin_key)
      .maybeSingle();
    if (pluginError) throw pluginError;
    if (!pluginRow) {
      return NextResponse.json(
        { error: `Unknown plugin: ${plugin_key}` },
        { status: 404 }
      );
    }

    const { error: upsertError } = await supabase
      .from("user_plugin_settings")
      .upsert(
        {
          user_id: user.id,
          plugin_key,
          enabled,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,plugin_key" }
      );
    if (upsertError) throw upsertError;

    try {
      triggerAgentReload();
    } catch {
      // Agent reload is best-effort.
    }

    return NextResponse.json({ success: true, plugin_key, enabled });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
