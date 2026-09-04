import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const COMPOSIO_BASE = "https://backend.composio.dev/api/v3.1";

function getSupabaseAdmin() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Supabase credentials not configured");
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function getSettings(ownerId?: string | null): Promise<Record<string, string>> {
    try {
        const supabase = getSupabaseAdmin();
        const { data: rows } = await supabase.from("agent_settings").select("key, value, user_id");
        const map: Record<string, string> = {};
        for (const row of rows || []) {
            if (!row.user_id) map[row.key] = row.value ?? "";
        }
        if (ownerId) {
            for (const row of rows || []) {
                if (row.user_id === ownerId) map[row.key] = row.value ?? "";
            }
        }
        return map;
    } catch {
        return {};
    }
}

async function getComposioConnection(
    toolkit: string,
    ownerId?: string | null
): Promise<{ composio_conn_id: string; user_id: string } | null> {
    try {
        const supabase = getSupabaseAdmin();
        const base = () =>
            supabase
                .from("mcp_connections")
                .select("id, composio_conn_id, user_id")
                .eq("connection_type", "composio")
                .ilike("toolkit_slug", toolkit)
                .eq("status", "active")
                .order("created_at", { ascending: false })
                .limit(1);

        if (ownerId) {
            const { data: owned } = await base().eq("user_id", ownerId).maybeSingle();
            if (owned) return owned;
        }

        const { data } = await base().maybeSingle();
        return data || null;
    } catch {
        return null;
    }
}

async function executeComposioTool(
    apiKey: string,
    toolSlug: string,
    args: Record<string, any>,
    connectedAccountId?: string,
    userId?: string
): Promise<any> {
    const payload: Record<string, any> = { arguments: args };
    if (connectedAccountId) payload.connected_account_id = connectedAccountId;
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
        throw new Error(errMsg);
    }
    return json.data || json;
}

/**
 * Checks YouTube video processing status for a single video.
 * If processing is finished ('processed'), automatically promotes privacy to 'public'
 * and updates the database row status to 'published'.
 */
export async function checkAndPromoteYoutubeProcessing(
    videoId: string,
    postId: string,
    connOrOwnerId?: { composio_conn_id?: string; user_id?: string } | string | null,
    apiKeyOverride?: string,
    targetPrivacy: string = "public"
): Promise<{ done: boolean; status?: string; error?: string }> {
    try {
        let composioApiKey = apiKeyOverride || process.env.COMPOSIO_API_KEY || "";
        let ytConn: { composio_conn_id?: string; user_id?: string } | null = null;
        let ownerId: string | null = null;

        if (connOrOwnerId && typeof connOrOwnerId === "object") {
            ytConn = connOrOwnerId;
            ownerId = connOrOwnerId.user_id || null;
        } else if (typeof connOrOwnerId === "string") {
            ownerId = connOrOwnerId;
        }

        if (!composioApiKey || !ytConn) {
            const settings = await getSettings(ownerId);
            if (!composioApiKey) {
                composioApiKey = process.env.COMPOSIO_API_KEY || settings.composio_api_key || "";
            }
            if (!ytConn) {
                ytConn = await getComposioConnection("youtube", ownerId);
            }
        }

        if (!composioApiKey || !ytConn?.composio_conn_id) {
            console.warn(`[youtube-monitor] Missing Composio API key or connection for video ${videoId}`);
            return { done: false, error: "Missing Composio connection" };
        }

        const detailsRes = await executeComposioTool(
            composioApiKey,
            "YOUTUBE_GET_VIDEO_DETAILS_BATCH",
            {
                id: [videoId],
                parts: ["status", "contentDetails"],
            },
            ytConn.composio_conn_id,
            ytConn.user_id
        );

        const items = detailsRes.items || detailsRes.data?.items || [];
        if (!items || items.length === 0) {
            console.warn(`[youtube-monitor] Video ${videoId} not yet returned in details batch, will retry.`);
            return { done: false };
        }

        const item = items[0];
        const uploadStatus = item.status?.uploadStatus;
        const currentPrivacy = item.status?.privacyStatus;
        console.log(`[youtube-monitor] Video ${videoId} status: uploadStatus='${uploadStatus}', privacyStatus='${currentPrivacy}'`);

        if (uploadStatus === "processed") {
            if (targetPrivacy === "public" && currentPrivacy !== "public") {
                console.log(`[youtube-monitor] Video ${videoId} processed! Promoting privacy to PUBLIC...`);
                await executeComposioTool(
                    composioApiKey,
                    "YOUTUBE_UPDATE_VIDEO",
                    {
                        video_id: videoId,
                        privacy_status: "public",
                    },
                    ytConn.composio_conn_id,
                    ytConn.user_id
                );
                console.log(`[youtube-monitor] Successfully made video ${videoId} PUBLIC!`);
            }

            // Mark row as published in Supabase
            const supabase = getSupabaseAdmin();
            await supabase
                .from("social_youtube_posts")
                .update({
                    status: "published",
                    published_video_id: videoId,
                    error_message: null,
                    updated_at: new Date().toISOString(),
                })
                .eq("post_id", postId);

            // Update main social_posts table published_to indicator
            const { data: mainPost } = await supabase
                .from("social_posts")
                .select("published_to")
                .eq("id", postId)
                .maybeSingle();

            const publishedTo = { ...(mainPost?.published_to || {}), youtube: true };
            await supabase
                .from("social_posts")
                .update({ published_to: publishedTo })
                .eq("id", postId);

            return { done: true, status: "published" };
        }

        if (uploadStatus === "rejected" || uploadStatus === "failed") {
            const rejectReason = item.status?.rejectionReason || `Processing ${uploadStatus} on YouTube`;
            console.error(`[youtube-monitor] Video ${videoId} failed/rejected: ${rejectReason}`);
            const supabase = getSupabaseAdmin();
            await supabase
                .from("social_youtube_posts")
                .update({
                    status: "failed",
                    published_video_id: videoId,
                    error_message: rejectReason.slice(0, 500),
                    updated_at: new Date().toISOString(),
                })
                .eq("post_id", postId);

            return { done: true, status: "failed", error: rejectReason };
        }

        // Still in 'uploaded' or transcode state
        return { done: false, status: "processing" };
    } catch (err: any) {
        console.warn(`[youtube-monitor] Error during check for ${videoId}:`, err?.message || err);
        return { done: false, error: err?.message };
    }
}

/**
 * Background loop: Polls YouTube processing status every 20 seconds for up to 15 minutes.
 */
export async function monitorAndPromoteYoutubeVideo(
    videoId: string,
    postId: string,
    connOrOwnerId?: { composio_conn_id?: string; user_id?: string } | string | null,
    apiKeyOverride?: string,
    targetPrivacy: string = "public"
): Promise<void> {
    console.log(`[youtube-monitor] Started background polling for video ${videoId}...`);
    // Wait initial 15 seconds for YouTube ingest to start
    await new Promise((r) => setTimeout(r, 15000));

    const maxAttempts = 30; // 30 attempts * 20s = 10 minutes max
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[youtube-monitor] Check attempt ${attempt}/${maxAttempts} for ${videoId}...`);
        const res = await checkAndPromoteYoutubeProcessing(videoId, postId, connOrOwnerId, apiKeyOverride, targetPrivacy);
        if (res.done) {
            console.log(`[youtube-monitor] Finished monitoring for ${videoId} with outcome:`, res.status);
            return;
        }
        await new Promise((r) => setTimeout(r, 20000));
    }
    console.log(`[youtube-monitor] Reached max polling attempts for ${videoId}. The cron heartbeat sweeper will continue checking.`);
}
