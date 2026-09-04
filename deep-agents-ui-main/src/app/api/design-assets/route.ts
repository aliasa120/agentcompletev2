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
          } catch { /* no-op */ }
        },
      },
    }
  );
}

import { triggerAgentReload } from "@/lib/agent-reloader";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";



// Repo root — two levels up from deep-agents-ui-main
const REPO_ROOT = join(process.cwd(), "..");
const REF_DIR = join(REPO_ROOT, "reference images");

// GET /api/design-assets — list all design assets from DB
export async function GET(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const folderId = searchParams.get("folder_id");
    let query = supabase.from("design_assets").select("*");
    if (folderId) query = query.eq("folder_id", folderId);
    const { data } = await query
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
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const label = (formData.get("label") as string | null) ?? "Reference Image";
    let assetKey = (formData.get("asset_key") as string | null) ?? "";
    const folderId = (formData.get("folder_id") as string | null) ?? "";
    let publicUrl = (formData.get("public_url") as string | null) ?? "";
    let storageKey = (formData.get("storage_key") as string | null) ?? "";
    let storageBackend = (formData.get("storage_backend") as string | null) ?? (publicUrl ? "r2" : "local_legacy");
    const mimeType = (formData.get("mime_type") as string | null) ?? file?.type ?? "";
    const sizeBytes = Number(formData.get("size_bytes") as string | null) || file?.size || 0;
    const mediaType =
      (formData.get("media_type") as string | null) ||
      (mimeType.startsWith("video/")
        ? "video"
        : mimeType.startsWith("audio/")
          ? "audio"
          : mimeType === "application/pdf"
            ? "document"
            : "image");

    if (!file && !publicUrl) {
      return NextResponse.json({ error: "file or public_url required" }, { status: 400 });
    }

    const bytes = file ? await file.arrayBuffer() : new ArrayBuffer(0);
    const buffer = Buffer.from(bytes);

    // Fallback: If no direct R2 publicUrl, attempt Supabase Storage upload before local disk
    if (file && !publicUrl) {
      for (const bucket of ["brand-assets", "uploads"]) {
        try {
          const cleanName = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
          const storagePath = `brand-assets/${user.id}/${Date.now()}_${cleanName}`;
          const { data: storageData, error: storageErr } = await supabase.storage
            .from(bucket)
            .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
          if (!storageErr && storageData) {
            const { data: pubData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
            if (pubData?.publicUrl) {
              publicUrl = pubData.publicUrl;
              storageKey = storagePath;
              storageBackend = "supabase";
              break;
            }
          }
        } catch {
          // continue fallback
        }
      }
    }

    if (file && !publicUrl && !existsSync(REF_DIR)) {
      mkdirSync(REF_DIR, { recursive: true });
    }

    if (assetKey) {
      const { data: existing } = await supabase
        .from("design_assets")
        .select("*")
        .eq("asset_key", assetKey)
        .single();

      if (!existing) {
        return NextResponse.json({ error: "Asset not found" }, { status: 404 });
      }

      if (file && !publicUrl && existing.file_path) {
        const targetPath = join(REPO_ROOT, existing.file_path);
        await writeFile(targetPath, buffer);
      }

      const { error } = await supabase
        .from("design_assets")
        .update({
          label,
          folder_id: folderId || existing.folder_id,
          public_url: publicUrl || existing.public_url,
          storage_key: storageKey || existing.storage_key,
          storage_backend: storageBackend || existing.storage_backend,
          mime_type: mimeType || existing.mime_type,
          size_bytes: sizeBytes || existing.size_bytes,
          media_type: mediaType || existing.media_type,
          updated_at: new Date().toISOString(),
        })
        .eq("asset_key", assetKey);
      if (error) throw error;

      try {
        triggerAgentReload();
      } catch (reloadErr) {
        console.warn("[design-assets] Failed to trigger agent reload on overwrite:", reloadErr);
      }

      return NextResponse.json({ success: true, asset_key: assetKey });
    }

    const timestamp = Date.now();
    const ext = file?.name.split(".").pop()?.toLowerCase() ?? "png";
    assetKey = `ref_image_${timestamp}`;
    const filename = `ref_image_${timestamp}.${ext}`;
    const filePath = publicUrl ? "" : `reference images/${filename}`;
    const targetPath = publicUrl ? "" : join(REPO_ROOT, filePath);

    const { data: maxRow } = await supabase
      .from("design_assets")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .single();
    const nextOrder = ((maxRow?.sort_order ?? 0) as number) + 1;

    if (file && !publicUrl) {
      await writeFile(targetPath, buffer);
    }

    const { data: created, error } = await supabase
      .from("design_assets")
      .insert({
        user_id: user.id,
        asset_key: assetKey,
        label,
        file_path: filePath,
        description: "",
        folder_id: folderId || null,
        media_type: mediaType,
        mime_type: mimeType,
        storage_backend: storageBackend,
        storage_key: storageKey,
        public_url: publicUrl || null,
        size_bytes: sizeBytes,
        source: "upload",
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
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// DELETE /api/design-assets — delete asset from DB and disk
// Body: { asset_key: string }
export async function DELETE(req: Request) {

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

// PATCH /api/design-assets — update asset metadata (e.g. move to another folder, change label/description)
export async function PATCH(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { asset_key, folder_id, label, description, sort_order } = await req.json();
    if (!asset_key) {
      return NextResponse.json({ error: "asset_key required" }, { status: 400 });
    }

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (folder_id !== undefined) updates.folder_id = folder_id || null;
    if (label !== undefined) updates.label = String(label).trim();
    if (description !== undefined) updates.description = String(description);
    if (sort_order !== undefined) updates.sort_order = Number(sort_order) || 0;

    const { data, error } = await supabase
      .from("design_assets")
      .update(updates)
      .eq("asset_key", asset_key)
      .select()
      .single();

    if (error) throw error;

    try {
      triggerAgentReload();
    } catch (reloadErr) {
      console.warn("[design-assets] Failed to trigger agent reload on patch:", reloadErr);
    }

    return NextResponse.json({ success: true, asset: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
