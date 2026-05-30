import { NextResponse } from "next/server";
import path from "path";
import { readFile } from "fs/promises";

const OUTPUT_DIR = path.join(process.cwd(), "..", "output");

export async function GET() {
    const filePath = path.join(OUTPUT_DIR, "social_post.jpg");
    try {
        const data = await readFile(filePath);
        return new NextResponse(data, {
            headers: {
                "Content-Type": "image/jpeg",
                "Cache-Control": "no-store",
            },
        });
    } catch {
        return NextResponse.json({ error: "social_post.jpg not found" }, { status: 404 });
    }
}
