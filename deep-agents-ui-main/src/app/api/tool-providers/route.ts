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

// GET /api/tool-providers?category=search|extract|image
export async function GET(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category");

  try {
    const { data, error } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "unified_tool_configs")
      .maybeSingle();

    if (error) throw error;

    let providers: any[] = [];
    if (data?.value) {
      try {
        providers = JSON.parse(data.value);
      } catch (err) {
        console.error("Failed to parse unified_tool_configs:", err);
      }
    } else {
      // Auto-seed with global tool_provider_configs values on first load
      const { data: globalData } = await supabase
        .from("tool_provider_configs")
        .select("*")
        .order("priority_order", { ascending: true });

      if (globalData && globalData.length > 0) {
        providers = globalData;
        await supabase
          .from("agent_settings")
          .upsert({
            user_id: user.id,
            key: "unified_tool_configs",
            value: JSON.stringify(providers),
            updated_at: new Date().toISOString()
          }, { onConflict: "user_id,key" });
      }
    }

    if (category) {
      providers = providers.filter((p: any) => p.tool_category === category);
    }

    // Ensure they are sorted by priority_order
    providers.sort((a, b) => (a.priority_order ?? 999) - (b.priority_order ?? 999));

    return NextResponse.json({ providers });
  } catch (e: unknown) {
    return NextResponse.json({ providers: [], error: e instanceof Error ? e.message : "Unknown" });
  }
}

// POST /api/tool-providers — upsert provider (add new or update)
export async function POST(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { tool_category, provider_key, provider_label, priority_order, enabled, fallback_on_error, custom_config } = body;

    if (!tool_category || !provider_key) {
      return NextResponse.json({ error: "tool_category and provider_key required" }, { status: 400 });
    }

    const { data: settingsRow } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "unified_tool_configs")
      .maybeSingle();

    let providers: any[] = [];
    if (settingsRow?.value) {
      try {
        providers = JSON.parse(settingsRow.value);
      } catch {}
    }

    // Prevent duplicates in same category and remove placeholders
    providers = providers.filter(
      p => !(p.tool_category === tool_category && p.provider_key === provider_key) &&
           !(p.tool_category === tool_category && p.provider_key === "placeholder")
    );

    const newProvider = {
      id: crypto.randomUUID(),
      tool_category,
      provider_key,
      provider_label: provider_label ?? provider_key,
      priority_order: priority_order ?? (providers.filter(p => p.tool_category === tool_category).length + 1),
      enabled: enabled ?? true,
      fallback_on_error: fallback_on_error ?? true,
      custom_config: custom_config ?? {},
    };

    providers.push(newProvider);

    const { error: upsertError } = await supabase
      .from("agent_settings")
      .upsert({
        user_id: user.id,
        key: "unified_tool_configs",
        value: JSON.stringify(providers),
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,key" });

    if (upsertError) throw upsertError;

    return NextResponse.json({ provider: newProvider });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// PATCH /api/tool-providers — bulk reorder
export async function PATCH(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { tool_category, ordered_providers } = await req.json();
    if (!tool_category || !Array.isArray(ordered_providers)) {
      return NextResponse.json({ error: "tool_category and ordered_providers required" }, { status: 400 });
    }

    const { data: settingsRow } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "unified_tool_configs")
      .maybeSingle();

    let providers: any[] = [];
    if (settingsRow?.value) {
      try {
        providers = JSON.parse(settingsRow.value);
      } catch {}
    }

    providers = providers.map(p => {
      if (p.tool_category !== tool_category) return p;
      const match = ordered_providers.find(op => op.id === p.id || (op.provider_key === p.provider_key && op.tool_category === p.tool_category));
      if (match) {
        return {
          ...p,
          priority_order: match.priority_order,
          enabled: match.enabled !== undefined ? match.enabled : p.enabled,
          fallback_on_error: match.fallback_on_error !== undefined ? match.fallback_on_error : p.fallback_on_error,
        };
      }
      return p;
    });

    const { error: upsertError } = await supabase
      .from("agent_settings")
      .upsert({
        user_id: user.id,
        key: "unified_tool_configs",
        value: JSON.stringify(providers),
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,key" });

    if (upsertError) throw upsertError;

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// DELETE /api/tool-providers?id=...
export async function DELETE(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { data: settingsRow } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("user_id", user.id)
      .eq("key", "unified_tool_configs")
      .maybeSingle();

    let providers: any[] = [];
    if (settingsRow?.value) {
      try {
        providers = JSON.parse(settingsRow.value);
      } catch {}
    }

    providers = providers.filter(p => p.id !== id);

    const { error: upsertError } = await supabase
      .from("agent_settings")
      .upsert({
        user_id: user.id,
        key: "unified_tool_configs",
        value: JSON.stringify(providers),
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id,key" });

    if (upsertError) throw upsertError;

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
