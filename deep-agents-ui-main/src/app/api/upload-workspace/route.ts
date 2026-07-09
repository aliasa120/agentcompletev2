import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(process.cwd(), "..");

export async function POST(request: NextRequest) {
  try {
    const { filename, base64 } = await request.json();
    if (!filename || !base64) {
      return NextResponse.json({ error: "Missing filename or base64 data" }, { status: 400 });
    }

    const safeFilename = path.basename(filename);
    const buffer = Buffer.from(base64, "base64");

    // Write to root of python agent's workspace
    const rootPath = path.join(REPO_ROOT, safeFilename);
    fs.writeFileSync(rootPath, buffer);

    // Also write to a tmp folder inside REPO_ROOT in case the agent looks there
    const tmpDir = path.join(REPO_ROOT, "tmp");
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const tmpPath = path.join(tmpDir, safeFilename);
    fs.writeFileSync(tmpPath, buffer);

    return NextResponse.json({ success: true, path: rootPath, tmpPath });
  } catch (error: any) {
    console.error("Upload workspace API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
