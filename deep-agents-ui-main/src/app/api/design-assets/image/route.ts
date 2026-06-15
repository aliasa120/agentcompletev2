import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const REPO_ROOT = join(process.cwd(), "..");

// GET /api/design-assets/image?key=ref_image_1 — serve image file
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const assetKey = searchParams.get("key");

  if (!assetKey) {
    return new NextResponse("asset key required", { status: 400 });
  }

  try {
    const { data: asset } = await supabase
      .from("design_assets")
      .select("file_path")
      .eq("asset_key", assetKey)
      .single();

    if (!asset?.file_path) {
      return new NextResponse("Asset not found", { status: 404 });
    }

    const filePath = join(REPO_ROOT, asset.file_path);
    if (!existsSync(filePath)) {
      return new NextResponse("Image file not found on disk", { status: 404 });
    }

    const imageBuffer = await readFile(filePath);
    const ext = filePath.toLowerCase().split(".").pop();
    const contentType =
      ext === "png" ? "image/png" :
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "webp" ? "image/webp" : "image/png";

    return new NextResponse(imageBuffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (e: unknown) {
    return new NextResponse(e instanceof Error ? e.message : "Unknown error", { status: 500 });
  }
}
