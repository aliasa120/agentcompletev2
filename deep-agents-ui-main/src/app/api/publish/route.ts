import { NextResponse } from "next/server";
import { TwitterApi } from "twitter-api-v2";
import { createClient } from "@supabase/supabase-js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { authorizeRequest, getSessionUser } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3.1";
const COMPOSIO_V3_FILES = "https://backend.composio.dev/api/v3/files/upload/request";

function getSupabaseAdmin() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Supabase credentials not configured");
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case ".mp4": return "video/mp4";
        case ".webm": return "video/webm";
        case ".mov": return "video/quicktime";
        case ".mkv": return "video/x-matroska";
        case ".jpg":
        case ".jpeg": return "image/jpeg";
        case ".png": return "image/png";
        case ".webp": return "image/webp";
        default: return "application/octet-stream";
    }
}

function sanitizeKeyPart(s: string): string {
    return s.replace(/[^a-zA-Z0-9_\-.]/g, "_").slice(0, 120) || "file";
}

function mediaCategory(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    if ([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"].includes(ext)) return "video";
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"].includes(ext)) return "images";
    if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(ext)) return "audio";
    return "uploads";
}

// ── Unified storage: R2 first (same credential + key layout as storage_service.py) ──

type R2Config = {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBaseUrl: string;
};

function getR2Config(settings: Record<string, string>): R2Config | null {
    const pick = (settingKey: string, envKey: string) =>
        (settings[settingKey] || "").trim() || (process.env[envKey] || "").trim();

    const cfg: R2Config = {
        accountId: pick("r2_account_id", "R2_ACCOUNT_ID"),
        accessKeyId: pick("r2_access_key_id", "R2_ACCESS_KEY_ID"),
        secretAccessKey: pick("r2_secret_access_key", "R2_SECRET_ACCESS_KEY"),
        bucket: pick("r2_bucket_name", "R2_BUCKET_NAME"),
        publicBaseUrl: pick("r2_public_base_url", "R2_PUBLIC_BASE_URL").replace(/\/+$/, ""),
    };
    if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucket || !cfg.publicBaseUrl) {
        return null;
    }
    return cfg;
}

async function registerThreadFile(opts: {
    userId: string | null;
    filename: string;
    storageBackend: "r2" | "supabase";
    storageKey: string;
    publicUrl: string;
    sizeBytes: number;
    mimeType: string;
    category: string;
    settings: Record<string, string>;
}): Promise<void> {
    if (!opts.userId) return;
    try {
        const retentionRaw = (opts.settings["storage_retention_days"] || process.env.STORAGE_RETENTION_DAYS || "").trim();
        let retentionDays = parseInt(retentionRaw || "30", 10);
        if (Number.isNaN(retentionDays) || retentionDays < 0) retentionDays = 30;
        const expiresAt = retentionDays > 0 ? new Date(Date.now() + retentionDays * 86400_000).toISOString() : null;

        await getSupabaseAdmin().from("thread_files").upsert(
            {
                user_id: opts.userId,
                thread_id: null,
                filename: opts.filename.slice(0, 250),
                storage_backend: opts.storageBackend,
                storage_key: opts.storageKey,
                public_url: opts.publicUrl,
                size_bytes: opts.sizeBytes,
                mime_type: opts.mimeType,
                category: opts.category,
                expires_at: expiresAt,
            },
            { onConflict: "storage_backend,storage_key" }
        );
    } catch (err) {
        console.warn("[publish] thread_files registration failed (non-fatal):", err);
    }
}

/** Upload local bytes to unified storage: R2 first, Supabase `uploads` bucket as fallback. */
async function uploadToUnifiedStorage(
    fileBytes: Buffer,
    filename: string,
    mimeType: string,
    settings: Record<string, string>,
    userId: string | null
): Promise<string> {
    const category = mediaCategory(filename);
    const today = new Date().toISOString().slice(0, 10);
    const uuid8 = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const key = `${category}/${today}/general/${uuid8}_${sanitizeKeyPart(filename)}`;

    // ── 1) Cloudflare R2 (primary, portable) ──
    const r2 = getR2Config(settings);
    if (r2) {
        try {
            const s3 = new S3Client({
                region: "auto",
                endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
                credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
            });
            await s3.send(
                new PutObjectCommand({
                    Bucket: r2.bucket,
                    Key: key,
                    Body: fileBytes,
                    ContentType: mimeType,
                })
            );
            const publicUrl = `${r2.publicBaseUrl}/${key}`;
            await registerThreadFile({
                userId, filename, storageBackend: "r2", storageKey: key,
                publicUrl, sizeBytes: fileBytes.length, mimeType, category, settings,
            });
            console.log(`[publish] uploaded media to R2: ${publicUrl}`);
            return publicUrl;
        } catch (err) {
            console.error("[publish] R2 upload failed, falling back to Supabase Storage:", err);
        }
    }

    // ── 2) Supabase Storage (fallback / legacy) ──
    const supabase = getSupabaseAdmin();
    const storageFileName = `upload_${Date.now()}_${sanitizeKeyPart(filename)}`;
    const { error: uploadError } = await supabase.storage
        .from("uploads")
        .upload(storageFileName, fileBytes, { contentType: mimeType, upsert: true });
    if (uploadError) {
        console.error("[publish] Supabase storage upload error:", uploadError);
    }
    const { data: publicUrlData } = supabase.storage.from("uploads").getPublicUrl(storageFileName);
    if (!publicUrlData?.publicUrl) {
        throw new Error(`Failed to upload media '${filename}' to storage`);
    }
    await registerThreadFile({
        userId, filename, storageBackend: "supabase", storageKey: storageFileName,
        publicUrl: publicUrlData.publicUrl, sizeBytes: fileBytes.length, mimeType, category, settings,
    });
    console.log(`[publish] uploaded media to Supabase (fallback): ${publicUrlData.publicUrl}`);
    return publicUrlData.publicUrl;
}

/** Recover a public URL for a bare filename via the portable thread_files registry. */
async function lookupRegisteredFile(reference: string): Promise<string | null> {
    const base = path.basename(reference.split("?")[0]).trim();
    if (!base) return null;
    try {
        const { data } = await getSupabaseAdmin()
            .from("thread_files")
            .select("public_url")
            .ilike("filename", base)
            .not("public_url", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (data?.public_url) {
            console.log(`[publish] resolved '${base}' via thread_files registry -> ${data.public_url}`);
            return data.public_url as string;
        }
    } catch (err) {
        console.warn("[publish] thread_files lookup failed:", err);
    }
    return null;
}

/** Resolve a media reference to a local file path, or null when it is not on this machine. */
function resolveLocalMediaPath(reference: string): string | null {
    const workspaceRoot = path.resolve(process.cwd(), "..");
    const candidates = [
        path.isAbsolute(reference) ? reference : path.resolve(workspaceRoot, reference),
        path.join(workspaceRoot, path.basename(reference)),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        } catch {
            /* ignore */
        }
    }
    return null;
}

/**
 * Ensure media is publicly reachable over HTTPS so Meta / Facebook / Instagram can download it.
 *
 * Resolution order:
 *   1. Public http(s) URL (R2 / Supabase / any CDN) → passed through untouched.
 *      This is the fast path: attachments already live on R2, so the platform
 *      fetches the bytes directly and no re-upload happens.
 *   2. Local file on this server → uploaded to unified storage (R2 first).
 *   3. Bare filename → recovered from the thread_files registry.
 *   4. Otherwise → throws, so the failure is explicit instead of silently
 *      publishing an unrelated file.
 */
async function ensurePublicMediaUrl(
    mediaUrlOrPath: string,
    settings: Record<string, string>,
    userId: string | null
): Promise<string> {
    const trimmed = (mediaUrlOrPath || "").trim();
    if (!trimmed) return "";

    // 1. Already a public HTTPS URL (and not localhost) → hand it straight to the platform.
    if (
        (trimmed.startsWith("http://") || trimmed.startsWith("https://")) &&
        !trimmed.includes("localhost") &&
        !trimmed.includes("127.0.0.1")
    ) {
        return trimmed;
    }

    // 2. Local file on this server → publish it to unified storage.
    const localPath = resolveLocalMediaPath(trimmed);
    if (localPath) {
        const fileBytes = fs.readFileSync(localPath);
        const mimeType = getMimeType(localPath);
        return uploadToUnifiedStorage(fileBytes, path.basename(localPath), mimeType, settings, userId);
    }

    // 3. Portable registry lookup (file was uploaded from another machine).
    const registered = await lookupRegisteredFile(trimmed);
    if (registered) return registered;

    // 4. Fail loudly — never substitute a different file.
    throw new Error(
        `Media not found: '${trimmed}'. Social platforms need a public HTTPS URL. ` +
        `Re-save the post with the attachment's storage URL, or upload the file first.`
    );
}

// Upload file to Composio S3 presigned URL for tools that require FileUploadable (e.g. YouTube)
async function uploadToComposioS3(
    mediaUrlOrPath: string,
    composioApiKey: string,
    toolSlug: string,
    toolkitSlug: string
): Promise<{ name: string; mimetype: string; s3key: string }> {
    let fileBuffer: Buffer;
    let fileName: string;
    let mimeType: string;

    if (mediaUrlOrPath.startsWith("http://") || mediaUrlOrPath.startsWith("https://")) {
        // YouTube needs the raw bytes, so the public URL (typically R2) is
        // downloaded once here and streamed to Composio's S3 staging bucket.
        const resp = await fetch(mediaUrlOrPath);
        if (!resp.ok) {
            throw new Error(
                `Failed to download media for upload (HTTP ${resp.status}): ${mediaUrlOrPath}`
            );
        }
        const arrayBuf = await resp.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuf);
        if (fileBuffer.length === 0) {
            throw new Error(`Downloaded media is empty: ${mediaUrlOrPath}`);
        }
        fileName = path.basename(new URL(mediaUrlOrPath).pathname) || `media_${Date.now()}.mp4`;
        mimeType = resp.headers.get("content-type") || getMimeType(fileName);
    } else {
        const resolvedPath = resolveLocalMediaPath(mediaUrlOrPath);
        if (!resolvedPath) {
            throw new Error(`Local file not found for upload: ${mediaUrlOrPath}`);
        }
        fileBuffer = fs.readFileSync(resolvedPath);
        fileName = sanitizeKeyPart(path.basename(resolvedPath));
        mimeType = getMimeType(resolvedPath);
    }

    const md5Hash = crypto.createHash("md5").update(fileBuffer).digest("hex");

    console.log(`[publish] Requesting Composio S3 presigned URL for ${fileName} (MD5: ${md5Hash})...`);
    const reqRes = await fetch(COMPOSIO_V3_FILES, {
        method: "POST",
        headers: {
            "x-api-key": composioApiKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            md5: md5Hash,
            filename: fileName,
            mimetype: mimeType,
            tool_slug: toolSlug,
            toolkit_slug: toolkitSlug,
        }),
    });

    const reqJson = await reqRes.json().catch(() => ({}));
    if (!reqRes.ok || !reqJson.new_presigned_url || !reqJson.key) {
        throw new Error(`Failed to obtain Composio S3 upload URL: ${reqJson.message || reqRes.statusText}`);
    }

    console.log(`[publish] Uploading ${fileBuffer.length} bytes to Composio S3 presigned URL...`);
    const putRes = await fetch(reqJson.new_presigned_url, {
        method: "PUT",
        headers: {
            "Content-Type": mimeType,
        },
        body: new Uint8Array(fileBuffer),
    });

    if (!putRes.ok) {
        throw new Error(`Failed to upload file to Composio S3 (HTTP ${putRes.status})`);
    }

    return {
        name: fileName,
        mimetype: mimeType,
        s3key: reqJson.key,
    };
}

/**
 * Load agent_settings. When ``ownerId`` is given, the owner's own rows win and
 * global rows only fill gaps, so a multi-user deployment resolves the right R2
 * credentials and page/channel targets.
 */
async function getSettings(ownerId?: string | null): Promise<Record<string, string>> {
    try {
        const supabase = getSupabaseAdmin();
        const { data: rows } = await supabase.from("agent_settings").select("key, value, user_id");
        const map: Record<string, string> = {};
        // Pass 1: rows with no owner (global defaults).
        for (const row of rows || []) {
            if (!row.user_id) map[row.key] = row.value ?? "";
        }
        // Pass 2: the owner's rows override globals.
        if (ownerId) {
            for (const row of rows || []) {
                if (row.user_id === ownerId) map[row.key] = row.value ?? "";
            }
        } else {
            // No owner context — keep legacy behaviour (last row wins).
            for (const row of rows || []) map[row.key] = row.value ?? "";
        }
        return map;
    } catch {
        return {};
    }
}

/**
 * Fetch the active Composio connection for a platform.
 *
 * Scoped to ``ownerId`` when known so a post never publishes through another
 * user's connected account; falls back to any active connection only when the
 * post has no owner (legacy rows).
 */
async function getComposioConnection(
    platform: string,
    ownerId?: string | null
): Promise<{ id: string; composio_conn_id: string; user_id: string } | null> {
    try {
        const supabase = getSupabaseAdmin();
        const base = () =>
            supabase
                .from("mcp_connections")
                .select("id, composio_conn_id, user_id")
                .eq("connection_type", "composio")
                .ilike("toolkit_slug", platform)
                .eq("status", "active")
                .order("created_at", { ascending: false })
                .limit(1);

        if (ownerId) {
            const { data: owned } = await base().eq("user_id", ownerId).maybeSingle();
            if (owned) return owned;
            console.warn(
                `[publish] no ${platform} Composio connection for owner ${ownerId} — post will not publish to ${platform}.`
            );
            return null;
        }

        const { data } = await base().maybeSingle();
        return data || null;
    } catch {
        return null;
    }
}

// Execute any tool via Composio v3.1 Tool Execution API
async function executeComposioTool(
    apiKey: string,
    toolSlug: string,
    args: Record<string, any>,
    connectedAccountId?: string,
    userId?: string
): Promise<any> {
    const payload: Record<string, any> = {
        arguments: args,
    };
    if (connectedAccountId) {
        payload.connected_account_id = connectedAccountId;
    }
    payload.user_id = userId || "default";

    const res = await fetch(`${COMPOSIO_BASE}/tools/execute/${toolSlug}`, {
        method: "POST",
        headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error || json.successful === false) {
        const errMsg =
            json.error?.message ||
            (typeof json.error === "string" ? json.error : null) ||
            json.data?.message ||
            json.data?.error ||
            json.message ||
            `Failed to execute Composio tool ${toolSlug}: ${JSON.stringify(json)}`;
        console.error(`[publish] Composio tool ${toolSlug} error:`, JSON.stringify(json));
        throw new Error(errMsg);
    }
    return json.data || json;
}

// Resolve legacy credential: env var takes priority over Supabase stored value
function cred(envKey: string, supabaseValue?: string): string {
    return process.env[envKey]?.trim() || supabaseValue?.trim() || "";
}

function sanitizeInstagramCaption(caption: string): string {
    if (!caption) return "";
    let clean = caption;
    const hashtagRegex = /#[\w\u0590-\u05ff\u0600-\u06ff]+/g;
    const matches = clean.match(hashtagRegex);
    if (matches && matches.length > 25) {
        let count = 0;
        clean = clean.replace(hashtagRegex, (match) => {
            count++;
            return count <= 25 ? match : "";
        }).replace(/\s{2,}/g, " ").trim();
    }
    if (clean.length > 2100) {
        clean = clean.substring(0, 2100).trim() + "...";
    }
    return clean;
}

async function publishInstagramUnified(
    post: any,
    settings: Record<string, string>,
    composioApiKey: string,
    conn: { composio_conn_id?: string; user_id?: string } | null,
    ownerId: string | null
): Promise<string> {
    const igData = post.instagram_data || {};
    const rawCaption = igData.caption || post.instagram || post.facebook || "";
    const caption = sanitizeInstagramCaption(rawCaption);
    const rawMedia = igData.media_url || post.image_url;
    const rawCover = igData.cover_url || post.image_url;
    const mediaType = igData.media_type || (rawMedia && isVideoMedia(rawMedia) ? "reel" : "photo");

    if (!rawMedia) {
        throw new Error("Instagram post requires an image or video file.");
    }

    // 1. Try Composio MCP first if available
    if (composioApiKey && conn) {
        console.log(`[publish] Resolving Instagram media to a public URL...`);
        const publicMediaUrl = await ensurePublicMediaUrl(rawMedia, settings, ownerId);
        const publicCoverUrl = rawCover ? await ensurePublicMediaUrl(rawCover, settings, ownerId) : "";

        console.log(`[publish] Publishing to Instagram via Composio (type: ${mediaType})...`);
        // Declared media_type wins; otherwise sniff the RESOLVED url (a bare
        // filename carries no reliable extension until it is resolved).
        const declaredType = String(igData.media_type || "").toLowerCase();
        const isVideoPost =
            declaredType === "reel" || declaredType === "video"
                ? true
                : declaredType === "photo"
                  ? false
                  : isVideoMedia(publicMediaUrl);
        const isPhoto = !isVideoPost;
        const containerArgs: Record<string, any> = {
            ig_user_id: "me",
            caption,
            media_type: isPhoto ? "IMAGE" : (mediaType === "video" ? "VIDEO" : "REELS"),
        };
        if (isPhoto) {
            containerArgs.image_url = publicMediaUrl;
        } else {
            containerArgs.video_url = publicMediaUrl;
            if (publicCoverUrl && publicCoverUrl !== publicMediaUrl) {
                containerArgs.cover_url = publicCoverUrl;
            }
        }

        const containerRes = await executeComposioTool(
            composioApiKey,
            "INSTAGRAM_CREATE_MEDIA_CONTAINER",
            containerArgs,
            conn.composio_conn_id,
            conn.user_id
        );

        const creationId = containerRes.id || containerRes.creation_id;
        if (!creationId) {
            throw new Error(`Failed to obtain Instagram creation_id from Composio: ${JSON.stringify(containerRes)}`);
        }

        const publishRes = await executeComposioTool(
            composioApiKey,
            "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
            {
                ig_user_id: "me",
                creation_id: creationId,
                max_wait_seconds: 180,
            },
            conn.composio_conn_id,
            conn.user_id
        );

        return publishRes.id || creationId;
    }

    // 2. Legacy Meta Graph API fallback
    const fbToken = cred("FB_TOKEN", settings.social_fb_token);
    const igAccountId = cred("IG_ACCOUNT_ID", settings.social_ig_account_id);
    if (!fbToken || !igAccountId) {
        throw new Error("Instagram not connected. Please connect Instagram via Composio in Posts Settings.");
    }

    const publicMediaUrl = await ensurePublicMediaUrl(rawMedia, settings, ownerId);
    const isVideo = mediaType === "reel" || mediaType === "video" || isVideoMedia(publicMediaUrl);

    const containerRes = await fetch(`https://graph.facebook.com/v21.0/${igAccountId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            media_type: isVideo ? "REELS" : "IMAGE",
            [isVideo ? "video_url" : "image_url"]: publicMediaUrl,
            caption,
            access_token: fbToken,
        }),
    });
    const containerData = await containerRes.json();
    if (containerData.error) throw new Error(containerData.error.message);

    if (isVideo) {
        await new Promise((r) => setTimeout(r, 6000));
    }

    const publishRes = await fetch(`https://graph.facebook.com/v21.0/${igAccountId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: containerData.id, access_token: fbToken }),
    });
    const publishData = await publishRes.json();
    if (publishData.error) throw new Error(publishData.error.message);
    return publishData.id;
}

function isVideoMedia(urlOrPath: string): boolean {
    const l = (urlOrPath || "").toLowerCase();
    return l.endsWith(".mp4") || l.endsWith(".mov") || l.endsWith(".webm") || l.endsWith(".mkv");
}

// Helper: Publish to Facebook via Composio (with target page selection)
async function publishFacebookUnified(
    post: any,
    settings: Record<string, string>,
    composioApiKey: string,
    conn: { composio_conn_id?: string; user_id?: string } | null,
    ownerId: string | null
): Promise<string> {
    const fbData = post.facebook_data || {};
    const message = fbData.message || post.facebook || post.twitter || "";
    const rawMedia = fbData.media_url || post.image_url;
    const title = fbData.title || post.title || "";
    const targetPageId = settings.fb_page_id || settings.social_fb_page_id || "";

    // 1. Try Composio MCP first
    if (composioApiKey && conn) {
        // Media is resolved BEFORE deciding video vs photo, because a bare
        // filename has no reliable extension until it resolves to a real URL.
        const publicMediaUrl = rawMedia ? await ensurePublicMediaUrl(rawMedia, settings, ownerId) : "";
        const declaredType = String(fbData.media_type || "").toLowerCase();
        const isVideo =
            declaredType === "video"
                ? true
                : declaredType === "photo"
                  ? false
                  : Boolean(publicMediaUrl) && isVideoMedia(publicMediaUrl);

        console.log(`[publish] Publishing to Facebook via Composio (isVideo: ${isVideo}, page_id: ${targetPageId || "default"})...`);

        if (isVideo && publicMediaUrl) {
            const args: Record<string, any> = {
                file_url: publicMediaUrl,
                title: title || message.slice(0, 50),
                description: message,
                published: true,
            };
            if (targetPageId) args.page_id = targetPageId;

            const res = await executeComposioTool(
                composioApiKey,
                "FACEBOOK_CREATE_VIDEO_POST",
                args,
                conn.composio_conn_id,
                conn.user_id
            );
            return res.id || res.post_id || "fb_video_published";
        } else if (publicMediaUrl) {
            const args: Record<string, any> = {
                url: publicMediaUrl,
                message,
                published: true,
            };
            if (targetPageId) args.page_id = targetPageId;

            const res = await executeComposioTool(
                composioApiKey,
                "FACEBOOK_CREATE_PHOTO_POST",
                args,
                conn.composio_conn_id,
                conn.user_id
            );
            return res.id || res.post_id || "fb_photo_published";
        } else {
            const args: Record<string, any> = {
                message,
                published: true,
            };
            if (targetPageId) args.page_id = targetPageId;

            const res = await executeComposioTool(
                composioApiKey,
                "FACEBOOK_CREATE_POST",
                args,
                conn.composio_conn_id,
                conn.user_id
            );
            return res.id || res.post_id || "fb_post_published";
        }
    }

    // 2. Legacy Meta Graph API fallback
    const fbToken = cred("FB_TOKEN", settings.social_fb_token);
    const fbPageId = targetPageId || cred("FB_PAGE_ID", settings.social_fb_page_id);
    if (!fbToken || !fbPageId) {
        throw new Error("Facebook not connected. Please connect Facebook via Composio in Posts Settings.");
    }

    let endpoint = `https://graph.facebook.com/v21.0/${fbPageId}/feed`;
    const body: Record<string, any> = { message, access_token: fbToken };

    if (rawMedia) {
        const publicMediaUrl = await ensurePublicMediaUrl(rawMedia, settings, ownerId);
        const declaredType = String(fbData.media_type || "").toLowerCase();
        const isVideo =
            declaredType === "video" ? true : declaredType === "photo" ? false : isVideoMedia(publicMediaUrl);
        if (isVideo) {
            endpoint = `https://graph.facebook.com/v21.0/${fbPageId}/videos`;
            body.file_url = publicMediaUrl;
            body.description = message;
        } else {
            endpoint = `https://graph.facebook.com/v21.0/${fbPageId}/photos`;
            body.url = publicMediaUrl;
        }
    }

    const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.id || data.post_id;
}

// Helper: Publish to YouTube via Composio
async function publishYoutubeUnified(
    post: any,
    settings: Record<string, string>,
    composioApiKey: string,
    conn: { composio_conn_id?: string; user_id?: string } | null,
    ownerId: string | null
): Promise<string> {
    const ytData = post.youtube_data || {};
    let title = (ytData.title || post.title || "New Video Upload").trim();
    if (title.length > 95) {
        title = title.substring(0, 95).trim();
    }
    const description = ytData.description || post.facebook || post.instagram || "";
    const rawVideo = ytData.video_url || "";
    const rawThumbnail = ytData.thumbnail_url || "";
    const tags = ytData.tags || [];
    const privacyStatus = ytData.privacy_status || "public";
    const categoryId = ytData.category_id || "22";

    if (!composioApiKey || !conn) {
        throw new Error("YouTube not connected. Please connect YouTube via Composio in Posts Settings.");
    }
    if (!rawVideo) {
        throw new Error(
            "YouTube upload requires a video file. Re-save the post with youtube_data.video_url set to the video's public storage URL."
        );
    }
    // Never let a still image be uploaded as a video (post.image_url used to leak in here).
    if (/\.(png|jpe?g|webp|gif|bmp|svg)(\?|$)/i.test(rawVideo)) {
        throw new Error(`YouTube upload requires a video file, but video_url points at an image: ${rawVideo}`);
    }

    // Resolve to a public URL first (bare filename → registry / storage upload),
    // then download those bytes once and stage them in Composio's S3 bucket.
    const publicVideoUrl = await ensurePublicMediaUrl(rawVideo, settings, ownerId);

    console.log(`[publish] Uploading video to Composio S3 for YouTube: ${title}...`);
    const fileUploadable = await uploadToComposioS3(
        publicVideoUrl,
        composioApiKey,
        "YOUTUBE_UPLOAD_VIDEO",
        "youtube"
    );

    console.log(`[publish] Calling YOUTUBE_UPLOAD_VIDEO with S3 key: ${fileUploadable.s3key}...`);
    const uploadRes = await executeComposioTool(
        composioApiKey,
        "YOUTUBE_UPLOAD_VIDEO",
        {
            title,
            description,
            videoFilePath: fileUploadable,
            tags,
            categoryId,
            privacyStatus,
        },
        conn.composio_conn_id,
        conn.user_id
    );

    const videoId =
        uploadRes.id ||
        uploadRes.video_id ||
        uploadRes.videoId ||
        uploadRes.response_data?.id;

    if (!videoId) {
        throw new Error(`YouTube upload response missing video ID: ${JSON.stringify(uploadRes)}`);
    }

    // Apply custom thumbnail if provided
    if (rawThumbnail && videoId) {
        console.log(`[publish] Applying custom thumbnail to YouTube video (${videoId})...`);
        try {
            const publicThumbUrl = await ensurePublicMediaUrl(rawThumbnail, settings, ownerId);
            await executeComposioTool(
                composioApiKey,
                "YOUTUBE_UPDATE_THUMBNAIL",
                {
                    videoId,
                    thumbnailUrl: publicThumbUrl,
                },
                conn.composio_conn_id,
                conn.user_id
            );
        } catch (thumbErr) {
            console.warn("[publish] Warning: Custom thumbnail update failed (non-fatal):", thumbErr);
        }
    }

    return videoId;
}

// Helper: Publish to Twitter / X via Composio or Twitter API v2
async function publishTwitterUnified(
    post: any,
    settings: Record<string, string>,
    composioApiKey: string,
    conn: { composio_conn_id?: string; user_id?: string } | null
): Promise<string> {
    const text = post.twitter || post.facebook || post.title || "";

    // 1. Try Composio MCP first
    if (composioApiKey && conn) {
        console.log("[publish] Posting tweet via Composio...");
        const res = await executeComposioTool(
            composioApiKey,
            "TWITTER_CREATION_OF_A_POST",
            { text },
            conn.composio_conn_id,
            conn.user_id
        );
        return res.id || res.data?.id || "tweet_published";
    }

    // 2. Legacy Twitter API v2 fallback
    const appKey = cred("TWITTER_API_KEY", settings.social_twitter_api_key);
    const appSecret = cred("TWITTER_API_SECRET", settings.social_twitter_api_secret);
    const accessToken = cred("TWITTER_ACCESS_TOKEN", settings.social_twitter_access_token);
    const accessSecret = cred("TWITTER_ACCESS_SECRET", settings.social_twitter_access_secret);

    if (!appKey || !appSecret || !accessToken || !accessSecret) {
        throw new Error("Twitter not connected. Please connect X via Composio in Posts Settings.");
    }

    const client = new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
    const tweet = await client.v2.tweet(text);
    return tweet.data.id;
}

// ── Per-platform draft-row status writeback ────────────────────────────────────

const PLATFORM_TABLES: Record<string, { table: string; idColumn: string }> = {
    instagram: { table: "social_instagram_posts", idColumn: "published_media_id" },
    facebook: { table: "social_facebook_posts", idColumn: "published_post_id" },
    youtube: { table: "social_youtube_posts", idColumn: "published_video_id" },
};

/** Mirror the publish outcome onto the platform draft row so it stops showing as 'draft'. */
async function updatePlatformRow(
    platform: string,
    postId: string,
    outcome: { success: boolean; publishedId?: string; error?: string }
): Promise<void> {
    const mapping = PLATFORM_TABLES[platform];
    if (!mapping) return; // twitter has no draft table
    try {
        const patch: Record<string, any> = {
            status: outcome.success ? "published" : "failed",
            error_message: outcome.success ? null : (outcome.error || "").slice(0, 500),
            updated_at: new Date().toISOString(),
        };
        if (outcome.success && outcome.publishedId) patch[mapping.idColumn] = outcome.publishedId;

        await getSupabaseAdmin().from(mapping.table).update(patch).eq("post_id", postId);
    } catch (err) {
        console.warn(`[publish] failed to update ${mapping.table} status (non-fatal):`, err);
    }
}

// In-flight guard: stops the same (post, platform) from being published twice
// concurrently when the agent's immediate auto-publish and the cron sweep overlap.
const inFlight = new Set<string>();

export async function POST(req: Request) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return NextResponse.json({ success: false, error: "Supabase not configured" }, { status: 503 });
    }

    // Publishing spends the user's connected accounts — require a signed-in
    // session or the internal service token (cron / agent auto-publish).
    const caller = await authorizeRequest(req);
    if (!caller) {
        return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { post_id, platforms = ["facebook", "instagram", "youtube", "twitter"] } = body;

    if (!post_id) {
        return NextResponse.json({ success: false, error: "post_id is required" }, { status: 400 });
    }

    // Fetch the post from Supabase
    const supabase = getSupabaseAdmin();
    const { data: post, error: postErr } = await supabase
        .from("social_posts")
        .select("*")
        .eq("id", post_id)
        .single();

    if (postErr || !post) {
        return NextResponse.json({ success: false, error: "Post not found" }, { status: 404 });
    }

    // A signed-in user may only publish their own posts. Legacy rows without an
    // owner stay accessible so existing drafts keep working.
    if (caller.kind === "user" && post.user_id && post.user_id !== caller.userId) {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    // The post's owner drives credential + connection resolution so a multi-user
    // deployment never publishes to somebody else's connected account.
    const ownerId: string | null = post.user_id ?? (caller.kind === "user" ? caller.userId : null);

    const settings = await getSettings(ownerId);
    const composioApiKey = process.env.COMPOSIO_API_KEY || settings.composio_api_key || "";

    // Fetch active Composio connections for each platform (owner-scoped)
    const [fbConn, igConn, ytConn, twConn] = await Promise.all([
        getComposioConnection("facebook", ownerId),
        getComposioConnection("instagram", ownerId),
        getComposioConnection("youtube", ownerId),
        getComposioConnection("twitter", ownerId),
    ]);

    const results: Record<string, { success: boolean; post_id?: string; error?: string; skipped?: boolean }> = {};
    const currentPublishedTo = { ...(post.published_to || {}) };

    /** Run one platform publish with the in-flight guard + status writeback applied. */
    async function runPlatform(
        platform: string,
        publisher: () => Promise<string>
    ): Promise<void> {
        const lockKey = `${post_id}:${platform}`;
        if (inFlight.has(lockKey)) {
            console.warn(`[publish] ${platform} for post ${post_id} is already publishing — skipping duplicate.`);
            results[platform] = { success: false, skipped: true, error: "Already publishing (duplicate request)" };
            return;
        }
        inFlight.add(lockKey);
        try {
            const publishedId = await publisher();
            results[platform] = { success: true, post_id: publishedId };
            currentPublishedTo[platform] = true;
            await updatePlatformRow(platform, post_id, { success: true, publishedId });
        } catch (e: any) {
            const message = e?.message || String(e);
            results[platform] = { success: false, error: message };
            await updatePlatformRow(platform, post_id, { success: false, error: message });
        } finally {
            inFlight.delete(lockKey);
        }
    }

    // 1. Facebook
    if (platforms.includes("facebook") && (post.facebook || post.facebook_data)) {
        await runPlatform("facebook", () =>
            publishFacebookUnified(post, settings, composioApiKey, fbConn, ownerId)
        );
    }

    // 2. Instagram
    if (platforms.includes("instagram") && (post.instagram || post.instagram_data)) {
        await runPlatform("instagram", () =>
            publishInstagramUnified(post, settings, composioApiKey, igConn, ownerId)
        );
    }

    // 3. YouTube
    if (platforms.includes("youtube") && (post.youtube || post.youtube_data)) {
        await runPlatform("youtube", () =>
            publishYoutubeUnified(post, settings, composioApiKey, ytConn, ownerId)
        );
    }

    // 4. Twitter / X
    if (platforms.includes("twitter") && (post.twitter || post.title)) {
        await runPlatform("twitter", () =>
            publishTwitterUnified(post, settings, composioApiKey, twConn)
        );
    }

    // Update published status in database
    await supabase
        .from("social_posts")
        .update({ published_to: currentPublishedTo })
        .eq("id", post_id);

    return NextResponse.json({
        success: Object.values(results).some((r) => r.success),
        results,
        published_to: currentPublishedTo,
    });
}

// GET: Connection health check
export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const platform = searchParams.get("platform") || "all";

    // Connection status is per-user; unauthenticated callers get nothing.
    const user = await getSessionUser();
    if (!user) {
        return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    const ownerId = user.id;
    const settings = await getSettings(ownerId);

    if (platform === "facebook") {
        const conn = await getComposioConnection("facebook", ownerId);
        const fbPageId = settings.fb_page_id || settings.social_fb_page_id;
        const fbPageName = settings.fb_page_name || settings.social_fb_page_name;
        if (conn) {
            return NextResponse.json({
                success: true,
                connected: true,
                mode: "composio",
                page_id: fbPageId,
                page_name: fbPageName,
                info: fbPageName ? `Connected to Facebook Page: ${fbPageName}` : "Connected via Composio",
            });
        }
        return NextResponse.json({ success: false, connected: false });
    }

    if (platform === "instagram") {
        const conn = await getComposioConnection("instagram", ownerId);
        if (conn) {
            return NextResponse.json({
                success: true,
                connected: true,
                mode: "composio",
                info: "Connected via Composio",
            });
        }
        return NextResponse.json({ success: false, connected: false });
    }

    if (platform === "youtube") {
        const conn = await getComposioConnection("youtube", ownerId);
        const ytTitle = settings.yt_channel_title || settings.social_yt_channel_title;
        if (conn) {
            return NextResponse.json({
                success: true,
                connected: true,
                mode: "composio",
                channel_title: ytTitle,
                info: ytTitle ? `Connected to YouTube Channel: ${ytTitle}` : "Connected via Composio",
            });
        }
        return NextResponse.json({ success: false, connected: false });
    }

    // X / Twitter had no dedicated branch, so its "Test" button always reported
    // not-connected. Handle it explicitly.
    if (platform === "twitter" || platform === "x") {
        const conn = await getComposioConnection("twitter", ownerId);
        if (conn) {
            return NextResponse.json({
                success: true,
                connected: true,
                mode: "composio",
                info: "Connected via Composio",
            });
        }
        return NextResponse.json({ success: false, connected: false });
    }

    return NextResponse.json({
        success: true,
        facebook: !!(await getComposioConnection("facebook", ownerId)),
        instagram: !!(await getComposioConnection("instagram", ownerId)),
        youtube: !!(await getComposioConnection("youtube", ownerId)),
        twitter: !!(await getComposioConnection("twitter", ownerId)),
    });
}
