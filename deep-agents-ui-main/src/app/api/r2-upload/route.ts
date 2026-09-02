import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const MAX_SIZE = 200 * 1024 * 1024; // 200MB

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
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const threadId = (formData.get("threadId") as string) || null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
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
      return NextResponse.json({ enabled: false, error: "R2 not configured" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const safeThread = threadId ? sanitizeKeyPart(String(threadId)) : "general";
    const uuid8 = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const key = `uploads/${today}/${safeThread}/${uuid8}_${sanitizeKeyPart(file.name)}`;

    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });

    const mime = (file.type || "application/octet-stream").trim();
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mime,
      })
    );

    const publicUrl = publicBaseUrl ? `${publicBaseUrl}/${key}` : null;

    // ── Register in thread_files ──
    const retentionRaw = (settings["storage_retention_days"] || process.env.STORAGE_RETENTION_DAYS || "").trim();
    let retentionDays = parseInt(retentionRaw || "30", 10);
    if (Number.isNaN(retentionDays) || retentionDays < 0) retentionDays = 30;
    const expiresAt =
      retentionDays > 0 ? new Date(Date.now() + retentionDays * 86400_000).toISOString() : null;

    await supabase.from("thread_files").upsert(
      {
        user_id: user.id,
        thread_id: threadId ? String(threadId) : null,
        filename: file.name.slice(0, 250),
        storage_backend: "r2",
        storage_key: key,
        public_url: publicUrl,
        size_bytes: file.size,
        mime_type: mime,
        category: "uploads",
        expires_at: expiresAt,
      },
      { onConflict: "storage_backend,storage_key" }
    );

    if (!publicUrl) {
      return NextResponse.json({ enabled: false });
    }

    return NextResponse.json({ enabled: true, publicUrl, key });
  } catch (e: unknown) {
    console.error("[r2-upload] server error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
