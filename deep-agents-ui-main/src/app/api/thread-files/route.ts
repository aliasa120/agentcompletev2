/**
 * Thread workspace files — listing.
 *
 * Files the agent creates with `write_file` / `terminal` live on disk in
 * `output/threads/<thread_id>/`. Small text files are mirrored into LangGraph
 * state so the FILE SYSTEM panel can open them directly, but binaries (PDF,
 * PNG, MP4, XLSX…) and large files are not. This route lists everything in the
 * thread workspace so the UI can show and open those too.
 *
 * GET /api/thread-files?threadId=<id>
 *   → { files: [{ path, name, size, mimeType, modifiedAt, isText, url }] }
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getSessionUser } from "@/lib/api-auth";
import {
  THREADS_ROOT,
  sanitizeThreadId,
  guessMimeType,
  isTextFile,
  SKIP_DIRS,
  assertThreadOwnership,
} from "@/lib/thread-files";

export const dynamic = "force-dynamic";

const MAX_ENTRIES = 500;

type Entry = {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
  isText: boolean;
  url: string;
};

function walk(baseDir: string, threadId: string): Entry[] {
  const out: Entry[] = [];

  const visit = (dir: string) => {
    if (out.length >= MAX_ENTRIES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (out.length >= MAX_ENTRIES) return;
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        visit(path.join(dir, dirent.name));
        continue;
      }
      if (!dirent.isFile()) continue;

      const full = path.join(dir, dirent.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const relative = path.relative(baseDir, full).split(path.sep).join("/");
      out.push({
        path: relative,
        name: dirent.name,
        size: stat.size,
        mimeType: guessMimeType(dirent.name),
        modifiedAt: stat.mtime.toISOString(),
        isText: isTextFile(dirent.name),
        url: `/api/thread-files/content?threadId=${encodeURIComponent(
          threadId
        )}&path=${encodeURIComponent(relative)}`,
      });
    }
  };

  visit(baseDir);
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const threadId = req.nextUrl.searchParams.get("threadId");
  if (!threadId) {
    return NextResponse.json({ files: [] });
  }

  const ownership = await assertThreadOwnership(threadId, user.id);
  if (!ownership.allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const safeThread = sanitizeThreadId(threadId);
  const threadDir = path.join(THREADS_ROOT, safeThread);

  // Path containment: sanitizeThreadId strips separators, but verify anyway.
  if (!threadDir.startsWith(THREADS_ROOT + path.sep)) {
    return NextResponse.json({ error: "Invalid threadId" }, { status: 400 });
  }
  if (!fs.existsSync(threadDir)) {
    return NextResponse.json({ files: [] });
  }

  try {
    return NextResponse.json({ files: walk(threadDir, threadId) });
  } catch (err: unknown) {
    console.error("[thread-files] listing error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list files", files: [] },
      { status: 500 }
    );
  }
}
