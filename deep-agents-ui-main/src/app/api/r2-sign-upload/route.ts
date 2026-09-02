import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * POST /api/r2-sign-upload
 *
 * Generates a presigned PUT URL so the browser can upload attachments
 * DIRECTLY to the user's Cloudflare R2 bucket (no bytes through this server).
 *
 * Request:  { filename, contentType, size, threadId? }
 * Response: { enabled: true, uploadUrl, publicUrl, key }
 *      or   { enabled: false }  → caller should fall back to Supabase upload
 *
 * The file is also registered in the thread_files registry (with the user's
 * storage_retention_days policy applied) so backend tools and other
 * deployments can resolve it later.
 *
 * NOTE: the R2 bucket needs a one-time CORS policy for browser PUTs — see
 * docs (AllowedOrigins = your app origin, AllowedMethods = PUT, GET).
 */

const MAX_SIZE = 200 * 1024 * 1024; // 200MB, matches attachment adapter cap

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
          } catch {}
        },
      },
    }
  );
}

function sanitizeKeyPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(0, 120) || "file";
}

export async function POST(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { filename, contentType, size, threadId } = await req.json();
    if (!filename || typeof size !== "number") {
      return NextResponse.json({ error: "filename and size are required" }, { status: 400 });
    }
    if (size > MAX_SIZE) {
      return NextResponse.json({ error: "File exceeds 200MB limit" }, { status: 413 });
    }

    // ── Resolve user's R2 credentials (agent_settings → env fallback) ──
    const { data: settingsRows } = await supabase
      .from("agent_settings")
      .select("key,value")
      .eq("user_id", user.id);
    const settings: Record<string, string> = {};
    for (const row of settingsRows ?? []) settings[row.key] = row.value;

    const pick = (settingKey: string, envKey: string) =>
      (settings[settingKey] || "").trim() || (process.env[envKey] || "").trim();

    const accountId = pick("r2_account_id", "R2_ACCOUNT_ID");
    const accessKeyId = pick("r2_access_key_id", "R2_ACCESS_KEY_ID");
    const secretAccessKey = pick("r2_secret_access_key", "R2_SECRET_ACCESS_KEY");
    const bucket = pick("r2_bucket_name", "R2_BUCKET_NAME");
    const publicBaseUrl = pick("r2_public_base_url", "R2_PUBLIC_BASE_URL").replace(/\/+$/, "");

    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      return NextResponse.json({ enabled: false });
    }

    // ── Build the object key (same layout as the Python storage service) ──
    const today = new Date().toISOString().slice(0, 10);
    const safeThread = threadId ? sanitizeKeyPart(String(threadId)) : "general";
    const uuid8 = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const key = `uploads/${today}/${safeThread}/${uuid8}_${sanitizeKeyPart(filename)}`;

    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });

    // Restrict the signature to the declared Content-Type (upload fails if mismatched)
    const mime = (contentType || "application/octet-stream").trim();
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: mime }),
      { expiresIn: 3600 }
    );

    const publicUrl = publicBaseUrl ? `${publicBaseUrl}/${key}` : null;

    // ── Register in thread_files (retention policy snapshot) ──
    const retentionRaw = (settings["storage_retention_days"] || process.env.STORAGE_RETENTION_DAYS || "").trim();
    let retentionDays = parseInt(retentionRaw || "30", 10);
    if (Number.isNaN(retentionDays) || retentionDays < 0) retentionDays = 30;
    const expiresAt =
      retentionDays > 0 ? new Date(Date.now() + retentionDays * 86400_000).toISOString() : null;

    await supabase.from("thread_files").upsert(
      {
        user_id: user.id,
        thread_id: threadId ? String(threadId) : null,
        filename: filename.slice(0, 250),
        storage_backend: "r2",
        storage_key: key,
        public_url: publicUrl,
        size_bytes: size,
        mime_type: mime,
        category: "uploads",
        expires_at: expiresAt,
      },
      { onConflict: "storage_backend,storage_key" }
    );

    if (!publicUrl) {
      // Without a public base URL the file is stored but not linkable — the
      // adapter must fall back to Supabase so chat history keeps stable URLs.
      return NextResponse.json({ enabled: false });
    }

    return NextResponse.json({ enabled: true, uploadUrl, publicUrl, key });
  } catch (e: unknown) {
    console.error("[r2-sign-upload] error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
