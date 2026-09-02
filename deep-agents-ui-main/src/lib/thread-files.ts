/**
 * Shared helpers for serving agent thread workspace files.
 *
 * The Python agent writes into `output/threads/<thread_id>/` (see
 * research_agent/fs_backend.py). These helpers mirror that layout and enforce
 * path containment so a caller can never escape the thread directory.
 */

import path from "path";
import { createClient } from "@supabase/supabase-js";

// Next.js runs from deep-agents-ui-main/, the agent workspace is its parent.
export const WORKSPACE_ROOT = path.resolve(process.cwd(), "..");
export const THREADS_ROOT = path.join(WORKSPACE_ROOT, "output", "threads");

/** Mirrors research_agent/fs_backend.sanitize_thread_id. */
export function sanitizeThreadId(threadId: string): string {
  if (!threadId) return "default";
  const safe = String(threadId).trim().replace(/[^a-zA-Z0-9_\-.]/g, "_");
  return safe || "default";
}

/** Heavy dependency/checkpoint trees that are never useful to list. */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".git",
  "__pycache__",
  ".next",
  ".langgraph_api",
  "checkpoints",
  "site-packages",
  "dist",
  "build",
  ".cache",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
]);

const MIME_BY_EXT: Record<string, string> = {
  // text / code
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  log: "text/plain",
  py: "text/x-python",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/css",
  sql: "text/plain",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  ps1: "text/plain",
  bat: "text/plain",
  xml: "application/xml",
  rst: "text/plain",
  tex: "text/plain",
  srt: "text/plain",
  vtt: "text/vtt",
  // documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
  zip: "application/zip",
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  // video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  m4v: "video/x-m4v",
};

export function fileExtension(filename: string): string {
  return path.extname(filename).toLowerCase().replace(/^\./, "");
}

export function guessMimeType(filename: string): string {
  return MIME_BY_EXT[fileExtension(filename)] || "application/octet-stream";
}

/** True for files the UI can render as editable text. */
export function isTextFile(filename: string): boolean {
  const mime = guessMimeType(filename);
  if (mime.startsWith("text/")) return true;
  return ["application/json", "application/xml"].includes(mime);
}

/**
 * Resolve a caller-supplied relative path inside a thread workspace.
 * Returns null when the path escapes the thread directory.
 */
export function resolveThreadFilePath(threadId: string, relativePath: string): string | null {
  const threadDir = path.join(THREADS_ROOT, sanitizeThreadId(threadId));
  if (!threadDir.startsWith(THREADS_ROOT + path.sep)) return null;

  const cleaned = String(relativePath || "").replace(/^[/\\]+/, "");
  if (!cleaned) return null;
  if (path.isAbsolute(cleaned)) return null;

  const resolved = path.resolve(threadDir, cleaned);
  if (resolved !== threadDir && !resolved.startsWith(threadDir + path.sep)) return null;
  return resolved;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getLangGraphApiUrl(): string {
  return (
    process.env.NEXT_PUBLIC_LANGGRAPH_API_URL ||
    process.env.LANGGRAPH_API_URL ||
    "http://localhost:2024"
  ).replace(/\/+$/, "");
}

/**
 * Verify a thread belongs to the signed-in user before serving its files.
 *
 * LangGraph thread metadata is the authority (the UI stamps `user_id` on every
 * submit). When the thread has no owner recorded — older threads, or LangGraph
 * unreachable — access is allowed so existing conversations keep working; that
 * matches how thread listing already behaves elsewhere in the app.
 */
export async function assertThreadOwnership(
  threadId: string,
  userId: string
): Promise<{ allowed: boolean; ownerId: string | null }> {
  try {
    const res = await fetch(`${getLangGraphApiUrl()}/threads/${encodeURIComponent(threadId)}`, {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const thread = await res.json().catch(() => null);
      const ownerId: string | null =
        thread?.metadata?.user_id ?? thread?.config?.configurable?.user_id ?? null;
      if (!ownerId) return { allowed: true, ownerId: null };
      return { allowed: ownerId === userId, ownerId };
    }
  } catch {
    /* LangGraph unreachable — fall through to the registry check */
  }

  // Fallback: the thread_files registry records the owner of uploaded files.
  try {
    const supabase = getSupabaseAdmin();
    if (supabase) {
      const { data } = await supabase
        .from("thread_files")
        .select("user_id")
        .eq("thread_id", threadId)
        .limit(1)
        .maybeSingle();
      if (data?.user_id) {
        return { allowed: data.user_id === userId, ownerId: data.user_id as string };
      }
    }
  } catch {
    /* ignore */
  }

  return { allowed: true, ownerId: null };
}
