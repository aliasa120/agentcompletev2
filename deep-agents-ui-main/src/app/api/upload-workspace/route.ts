/**
 * Copy a browser-side attachment into the agent's thread workspace.
 *
 * The agent's filesystem tools (`ls`, `read_file`, `glob`, `grep`, `terminal`)
 * are sandboxed to `output/threads/<thread_id>/`, so files must land there to be
 * visible. The previous version wrote to the repo root instead, where the agent
 * could never see them — and did so with no auth, no size limit, and no thread
 * scoping.
 *
 * POST { filename, base64, threadId? } → { success, path }
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getSessionUser } from "@/lib/api-auth";
import {
  THREADS_ROOT,
  sanitizeThreadId,
  assertThreadOwnership,
} from "@/lib/thread-files";

// Matches the client-side guard in attachment-adapter.ts (non-media files only).
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { filename, base64, threadId } = await request.json();
    if (!filename || !base64) {
      return NextResponse.json({ error: "Missing filename or base64 data" }, { status: 400 });
    }

    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) {
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }
    if (buffer.length > MAX_SIZE) {
      return NextResponse.json(
        { error: `File exceeds ${MAX_SIZE / (1024 * 1024)}MB workspace limit` },
        { status: 413 }
      );
    }

    if (threadId) {
      const ownership = await assertThreadOwnership(String(threadId), user.id);
      if (!ownership.allowed) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // basename() strips any directory component, so the write stays in the thread dir.
    const safeFilename = path.basename(String(filename));
    if (!safeFilename || safeFilename === "." || safeFilename === "..") {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    const threadDir = path.join(THREADS_ROOT, sanitizeThreadId(String(threadId || "default")));
    if (!threadDir.startsWith(THREADS_ROOT + path.sep)) {
      return NextResponse.json({ error: "Invalid threadId" }, { status: 400 });
    }

    fs.mkdirSync(threadDir, { recursive: true });
    const targetPath = path.join(threadDir, safeFilename);
    fs.writeFileSync(targetPath, buffer);

    return NextResponse.json({
      success: true,
      // Agents use simple relative paths inside their workspace.
      path: safeFilename,
      absolutePath: targetPath,
    });
  } catch (error: unknown) {
    console.error("[upload-workspace] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
