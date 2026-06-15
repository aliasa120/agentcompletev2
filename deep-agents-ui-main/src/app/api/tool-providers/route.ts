import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/tool-providers?category=search|extract|image
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category");

  try {
    let query = supabase
      .from("tool_provider_configs")
      .select("*")
      .order("priority_order", { ascending: true });

    if (category) query = query.eq("tool_category", category);

    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ providers: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ providers: [], error: e instanceof Error ? e.message : "Unknown" });
  }
}

// POST /api/tool-providers — upsert provider (add new or update)
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { tool_category, provider_key, provider_label, priority_order, enabled, fallback_on_error, custom_config } = body;

    if (!tool_category || !provider_key) {
      return NextResponse.json({ error: "tool_category and provider_key required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("tool_provider_configs")
      .upsert({
        tool_category,
        provider_key,
        provider_label: provider_label ?? provider_key,
        priority_order: priority_order ?? 99,
        enabled: enabled ?? true,
        fallback_on_error: fallback_on_error ?? true,
        custom_config: custom_config ?? {},
        updated_at: new Date().toISOString(),
      }, { onConflict: "tool_category,provider_key" })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ provider: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// PATCH /api/tool-providers — bulk reorder (update priority_order for all in category)
export async function PATCH(req: Request) {
  try {
    const { tool_category, ordered_providers } = await req.json();
    // ordered_providers = [{ id, provider_key, priority_order, enabled }]
    if (!tool_category || !Array.isArray(ordered_providers)) {
      return NextResponse.json({ error: "tool_category and ordered_providers required" }, { status: 400 });
    }

    for (const p of ordered_providers) {
      await supabase
        .from("tool_provider_configs")
        .update({
          priority_order: p.priority_order,
          enabled: p.enabled,
          updated_at: new Date().toISOString(),
        })
        .eq("id", p.id);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// DELETE /api/tool-providers?id=...
export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { error } = await supabase.from("tool_provider_configs").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
