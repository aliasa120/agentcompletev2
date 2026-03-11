import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { readFile } from "fs/promises";

const OUTPUT_DIR = path.join(process.cwd(), "..", "output");

const MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
};

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ platform: string }> }
) {
    const { platform } = await params;

    // Only allow twitter, instagram, facebook
    if (!["twitter", "instagram", "facebook"].includes(platform)) {
        return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
    }

    const filePath = path.join(OUTPUT_DIR, `${platform}.png`);

    try {
        const data = await readFile(filePath);
        return new NextResponse(data, {
            headers: {
                "Content-Type": MIME.png,
                "Cache-Control": "no-store",
            },
        });
    } catch {
        return NextResponse.json(
            { error: `Image for ${platform} not found` },
            { status: 404 }
        );
    }
}
