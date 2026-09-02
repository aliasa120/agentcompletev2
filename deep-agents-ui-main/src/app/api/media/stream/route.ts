import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import fs from "fs";
import path from "path";
import { getSessionUser } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mediaPath = searchParams.get("path") || searchParams.get("url");

  if (!mediaPath) {
    return new NextResponse("Missing path or url query parameter", { status: 400 });
  }

  // If already public HTTP/HTTPS URL, redirect to it
  if (mediaPath.startsWith("http://") || mediaPath.startsWith("https://")) {
    return NextResponse.redirect(mediaPath);
  }

  // Local paths are read off the server's disk, so require a session. Without
  // this the endpoint was an unauthenticated arbitrary-file read.
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const workspaceRoot = path.resolve(process.cwd(), "..");

    // Resolve absolute path or relative to workspace
    let resolvedPath = mediaPath;
    if (!path.isAbsolute(resolvedPath)) {
      resolvedPath = path.resolve(workspaceRoot, resolvedPath);
    }

    // If file doesn't exist directly, try resolving in workspace root.
    // No substitute-file fallback: serving an unrelated video on a miss made
    // "media not found" look like success.
    if (!fs.existsSync(resolvedPath)) {
      const tryPath = path.join(workspaceRoot, path.basename(mediaPath));
      if (fs.existsSync(tryPath)) {
        resolvedPath = tryPath;
      } else {
        return new NextResponse(`File not found: ${mediaPath}`, { status: 404 });
      }
    }

    // Containment: never serve anything outside the project workspace.
    if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(workspaceRoot + path.sep)) {
      return new NextResponse("Path outside workspace", { status: 403 });
    }
    if (!fs.statSync(resolvedPath).isFile()) {
      return new NextResponse("Not a file", { status: 400 });
    }

    const stat = fs.statSync(resolvedPath);
    const fileSize = stat.size;
    const mimeType = getMimeType(resolvedPath);
    const rangeHeader = req.headers.get("range");

    // Support HTTP Range requests for video seeking and smooth playback
    if (rangeHeader && rangeHeader.startsWith("bytes=")) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      // Handle invalid ranges
      if (isNaN(start) || start >= fileSize || (parts[1] && end >= fileSize) || start > end) {
        return new NextResponse(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${fileSize}`,
          },
        });
      }

      const chunkSize = end - start + 1;
      const fileStream = fs.createReadStream(resolvedPath, { start, end });
      const stream = Readable.toWeb(fileStream);

      return new NextResponse(stream as any, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": mimeType,
        },
      });
    } else {
      const fileStream = fs.createReadStream(resolvedPath);
      const stream = Readable.toWeb(fileStream);

      return new NextResponse(stream as any, {
        status: 200,
        headers: {
          "Content-Length": String(fileSize),
          "Content-Type": mimeType,
          "Accept-Ranges": "bytes",
        },
      });
    }
  } catch (err: any) {
    console.error("[media/stream] Error streaming media:", err);
    return new NextResponse(`Internal server error: ${err.message}`, { status: 500 });
  }
}
