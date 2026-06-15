import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { triggerAgentReload } from "@/lib/agent-reloader";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/design-assets/provider?provider_slug=kie_ai
// Returns all design assets attached to an image provider
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const provider_slug = searchParams.get("provider_slug");
  if (!provider_slug) return NextResponse.json({ error: "provider_slug required" }, { status: 400 });

  try {
    const { data, error } = await supabase
      .from("provider_design_assets")
      .select("id, design_asset_id, provider_slug, design_assets(id, asset_key, label, file_path, sort_order)")
      .eq("provider_slug", provider_slug)
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

// POST /api/design-assets/provider
// Body: { provider_slug, design_asset_id }
export async function POST(req: Request) {
  try {
    const { provider_slug, design_asset_id } = await req.json();
    if (!provider_slug || !design_asset_id) {
      return NextResponse.json({ error: "provider_slug and design_asset_id required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("provider_design_assets")
      .upsert({ provider_slug, design_asset_id }, { onConflict: "provider_slug,design_asset_id" })
      .select()
      .single();

    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[design-assets-provider] Failed to trigger agent reload on link:", reloadErr);
    }

    return NextResponse.json({ success: true, attachment: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// DELETE /api/design-assets/provider
// Body: { provider_slug, design_asset_id }
export async function DELETE(req: Request) {
  try {
    const { provider_slug, design_asset_id } = await req.json();
    if (!provider_slug || !design_asset_id) {
      return NextResponse.json({ error: "provider_slug and design_asset_id required" }, { status: 400 });
    }

    const { error } = await supabase
      .from("provider_design_assets")
      .delete()
      .eq("provider_slug", provider_slug)
      .eq("design_asset_id", design_asset_id);

    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[design-assets-provider] Failed to trigger agent reload on unlink:", reloadErr);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
