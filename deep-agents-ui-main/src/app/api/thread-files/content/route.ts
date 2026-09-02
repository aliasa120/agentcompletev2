/**
 * Thread workspace files — content streaming.
 *
 * GET /api/thread-files/content?threadId=<id>&path=<relative/path>[&download=1]
 *
 * Serves a single file from `output/threads/<thread_id>/` with Range support so
 * video and audio can be scrubbed in the browser. The path is always resolved
 * inside the thread directory (see resolveThreadFilePath) — there is no
 * workspace-wide fallback and no substitute file on a miss.
 */

import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import fs from "fs";
import path from "path";
import { getSessionUser } from "@/lib/api-auth";
import {
  guessMimeType,
  resolveThreadFilePath,
  assertThreadOwnership,
} from "@/lib/thread-files";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const threadId = searchParams.get("threadId");
  const relativePath = searchParams.get("path");
  const asDownload = searchParams.get("download") === "1";

  if (!threadId || !relativePath) {
    return new NextResponse("threadId and path are required", { status: 400 });
  }

  const ownership = await assertThreadOwnership(threadId, user.id);
  if (!ownership.allowed) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const resolved = resolveThreadFilePath(threadId, relativePath);
  if (!resolved) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return new NextResponse("File not found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new NextResponse("Not a file", { status: 400 });
  }

  const filename = path.basename(resolved);
  const mimeType = guessMimeType(filename);
  const disposition = `${asDownload ? "attachment" : "inline"}; filename="${filename.replace(/"/g, "")}"`;
  const rangeHeader = req.headers.get("range");

  try {
    // Range requests keep video/audio seekable.
    if (rangeHeader?.startsWith("bytes=")) {
      const [rawStart, rawEnd] = rangeHeader.replace("bytes=", "").split("-");
      const start = parseInt(rawStart, 10);
      const end = rawEnd ? parseInt(rawEnd, 10) : stat.size - 1;

      if (
        Number.isNaN(start) ||
        start >= stat.size ||
        (rawEnd && Number.isNaN(end)) ||
        start > end
      ) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${stat.size}` },
        });
      }

      const cappedEnd = Math.min(end, stat.size - 1);
      const stream = Readable.toWeb(
        fs.createReadStream(resolved, { start, end: cappedEnd })
      );
      return new NextResponse(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${cappedEnd}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(cappedEnd - start + 1),
          "Content-Type": mimeType,
          "Content-Disposition": disposition,
          "Cache-Control": "private, no-store",
        },
      });
    }

    const stream = Readable.toWeb(fs.createReadStream(resolved));
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Length": String(stat.size),
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err: unknown) {
    console.error("[thread-files/content] stream error:", err);
    return new NextResponse("Failed to read file", { status: 500 });
  }
}
