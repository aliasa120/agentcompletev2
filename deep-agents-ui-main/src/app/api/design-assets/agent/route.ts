import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { triggerAgentReload } from "@/lib/agent-reloader";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/design-assets/agent?agent_id=xxx
// Returns all design assets attached to an agent
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const agent_id = searchParams.get("agent_id");
  if (!agent_id) return NextResponse.json({ error: "agent_id required" }, { status: 400 });

  try {
    const { data, error } = await supabase
      .from("agent_design_assets")
      .select("id, design_asset_id, design_assets(id, asset_key, label, file_path, sort_order)")
      .eq("agent_id", agent_id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    const assets = (data ?? []).map((row: any) => ({
      attachment_id: row.id,
      ...(row.design_assets as object),
    }));

    return NextResponse.json({ assets });
  } catch (e: unknown) {
    return NextResponse.json({ assets: [], error: e instanceof Error ? e.message : "Unknown" });
  }
}

// POST /api/design-assets/agent
// Body: { agent_id, design_asset_id }
export async function POST(req: Request) {
  try {
    const { agent_id, design_asset_id } = await req.json();
    if (!agent_id || !design_asset_id) {
      return NextResponse.json({ error: "agent_id and design_asset_id required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("agent_design_assets")
      .upsert({ agent_id, design_asset_id }, { onConflict: "agent_id,design_asset_id" })
      .select()
      .single();

    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[design-assets-agent] Failed to trigger agent reload on link:", reloadErr);
    }

    return NextResponse.json({ success: true, attachment: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// DELETE /api/design-assets/agent
// Body: { agent_id, design_asset_id }
export async function DELETE(req: Request) {
  try {
    const { agent_id, design_asset_id } = await req.json();
    if (!agent_id || !design_asset_id) {
      return NextResponse.json({ error: "agent_id and design_asset_id required" }, { status: 400 });
    }

    const { error } = await supabase
      .from("agent_design_assets")
      .delete()
      .eq("agent_id", agent_id)
      .eq("design_asset_id", design_asset_id);

    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[design-assets-agent] Failed to trigger agent reload on unlink:", reloadErr);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
