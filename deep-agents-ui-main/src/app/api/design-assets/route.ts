import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { triggerAgentReload } from "@/lib/agent-reloader";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Repo root — two levels up from deep-agents-ui-main
const REPO_ROOT = join(process.cwd(), "..");
const REF_DIR = join(REPO_ROOT, "reference images");

// GET /api/design-assets — list all design assets from DB
export async function GET() {
  try {
    const { data } = await supabase
      .from("design_assets")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    return NextResponse.json({ assets: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ assets: [], error: e instanceof Error ? e.message : "Unknown" });
  }
}

// POST /api/design-assets — upload a new or replace existing image
// Body: FormData with: file (File), label (string), asset_key? (string, optional — if omitted creates new)
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const label = (formData.get("label") as string | null) ?? "Reference Image";
    let assetKey = (formData.get("asset_key") as string | null) ?? "";

    if (!file) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }

    // Ensure reference images directory exists
    if (!existsSync(REF_DIR)) mkdirSync(REF_DIR, { recursive: true });

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (assetKey) {
      // Replace existing asset — overwrite file in place
      const { data: existing } = await supabase
        .from("design_assets")
        .select("file_path")
        .eq("asset_key", assetKey)
        .single();

      if (!existing) {
        return NextResponse.json({ error: "Asset not found" }, { status: 404 });
      }

      const targetPath = join(REPO_ROOT, existing.file_path);
      await writeFile(targetPath, buffer);

      await supabase
        .from("design_assets")
        .update({ label, updated_at: new Date().toISOString() })
        .eq("asset_key", assetKey);

      try {
        triggerAgentReload();
      } catch (reloadErr) {
        console.warn("[design-assets] Failed to trigger agent reload on overwrite:", reloadErr);
      }

      return NextResponse.json({ success: true, asset_key: assetKey, path: existing.file_path });
    } else {
      // Create new asset — generate unique key and filename
      const timestamp = Date.now();
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
      assetKey = `ref_image_${timestamp}`;
      const filename = `ref_image_${timestamp}.${ext}`;
      const filePath = `reference images/${filename}`;
      const targetPath = join(REPO_ROOT, filePath);

      // Get current max sort_order
      const { data: maxRow } = await supabase
        .from("design_assets")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1)
        .single();
      const nextOrder = ((maxRow?.sort_order ?? 0) as number) + 1;

      await writeFile(targetPath, buffer);

      const { data: created, error } = await supabase
        .from("design_assets")
        .insert({
          asset_key: assetKey,
          label,
          file_path: filePath,
          description: "",
          sort_order: nextOrder,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;

      try {
        triggerAgentReload();
      } catch (reloadErr) {
        console.warn("[design-assets] Failed to trigger agent reload on create:", reloadErr);
      }

      return NextResponse.json({ success: true, asset: created });
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// DELETE /api/design-assets — delete asset from DB and disk
// Body: { asset_key: string }
export async function DELETE(req: Request) {
  try {
    const { asset_key } = await req.json();
    if (!asset_key) return NextResponse.json({ error: "asset_key required" }, { status: 400 });

    const { data: asset } = await supabase
      .from("design_assets")
      .select("id, file_path")
      .eq("asset_key", asset_key)
      .single();

    if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

    // Delete file from disk
    if (asset.file_path) {
      const filePath = join(REPO_ROOT, asset.file_path);
      if (existsSync(filePath)) {
        try { await unlink(filePath); } catch { /* ignore missing file */ }
      }
    }

    // Delete from agent_design_assets (cascade) and design_assets
    await supabase.from("agent_design_assets").delete().eq("design_asset_id", asset.id);
    await supabase.from("provider_design_assets").delete().eq("design_asset_id", asset.id);
    await supabase.from("design_assets").delete().eq("asset_key", asset_key);

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[design-assets] Failed to trigger agent reload on delete:", reloadErr);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
