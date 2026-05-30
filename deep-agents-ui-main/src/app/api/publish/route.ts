import { NextResponse } from "next/server";
import { TwitterApi } from "twitter-api-v2";

const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

async function getSettings(): Promise<Record<string, string>> {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/agent_settings?select=key,value`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        cache: "no-store",
    });
    const rows: { key: string; value: string }[] = await res.json();
    const map: Record<string, string> = {};
    for (const row of rows) map[row.key] = row.value ?? "";
    return map;
}

async function upsertSetting(key: string, value: string) {
    await fetch(`${SUPABASE_URL}/rest/v1/agent_settings`, {
        method: "POST",
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
}

// Resolve credential: env var takes priority over Supabase stored value
function cred(envKey: string, supabaseValue: string): string {
    return process.env[envKey]?.trim() || supabaseValue?.trim() || "";
}

// Fetch Page Access Token from user/system token
async function getPageToken(userToken: string, pageId: string): Promise<string> {
    const res = await fetch(
        `https://graph.facebook.com/v21.0/${pageId}?fields=access_token&access_token=${encodeURIComponent(userToken)}`
    );
    const data = await res.json();
    if (data.error) {
        console.error("[publish] Failed to get page token:", data.error.message, "- falling back to user token");
        return userToken;
    }
    return data.access_token || userToken;
}

// Poll Instagram container status until FINISHED (max 60s)
async function waitForInstagramContainer(token: string, containerId: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch(
            `https://graph.facebook.com/v21.0/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`
        );
        const data = await res.json();
        console.log(`[publish] Instagram container ${containerId} status: ${data.status_code}`);
        if (data.status_code === "FINISHED") return;
        if (data.status_code === "ERROR") {
            throw new Error("Instagram media processing failed. The image URL may not be publicly accessible or the format is unsupported.");
        }
    }
    throw new Error("Instagram media processing timed out (60s). Try again later.");
}

async function publishFacebook(
    userToken: string,
    pageId: string,
    message: string,
    imageUrl: string | null
): Promise<string> {
    // Always use Page Access Token for page posts
    const pageToken = await getPageToken(userToken, pageId);

    if (imageUrl) {
        const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/photos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: imageUrl, message, access_token: pageToken }),
        });
        const data = await res.json();
        if (data.error) throw new Error(`Facebook photo post failed: ${data.error.message}`);
        return data.post_id || data.id;
    } else {
        const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, access_token: pageToken }),
        });
        const data = await res.json();
        if (data.error) throw new Error(`Facebook feed post failed: ${data.error.message}`);
        return data.id;
    }
}

async function publishInstagram(
    token: string,
    igAccountId: string,
    caption: string,
    imageUrl: string | null
): Promise<string> {
    if (!imageUrl) throw new Error("Instagram requires an image. This post has no image.");

    // Step 1 — Create media container
    const containerPayload: Record<string, string> = {
        media_type: "IMAGE",
        image_url: imageUrl,
        caption,
        access_token: token,
    };

    const containerRes = await fetch(`https://graph.facebook.com/v21.0/${igAccountId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(containerPayload),
    });
    const containerData = await containerRes.json();
    if (containerData.error) {
        throw new Error(`Instagram container creation failed: ${containerData.error.message}`);
    }

    const creationId = containerData.id;
    console.log(`[publish] Instagram container created: ${creationId}`);

    // Step 2 — Wait for container to finish processing
    await waitForInstagramContainer(token, creationId);

    // Step 3 — Publish
    const publishRes = await fetch(`https://graph.facebook.com/v21.0/${igAccountId}/media_publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId, access_token: token }),
    });
    const publishData = await publishRes.json();
    if (publishData.error) {
        throw new Error(`Instagram publish failed: ${publishData.error.message}`);
    }
    return publishData.id;
}

async function publishTwitter(
    settings: Record<string, string>,
    tweetText: string,
    imageUrl: string | null
): Promise<string> {
    const appKey = cred("TWITTER_API_KEY", settings.social_twitter_api_key);
    const appSecret = cred("TWITTER_API_SECRET", settings.social_twitter_api_secret);
    const accessToken = cred("TWITTER_ACCESS_TOKEN", settings.social_twitter_access_token);
    const accessSecret = cred("TWITTER_ACCESS_SECRET", settings.social_twitter_access_secret);

    if (!appKey || !appSecret || !accessToken || !accessSecret) {
        throw new Error("Twitter credentials incomplete (Consumer Key, Consumer Secret, Access Token, Access Secret required). Configure them in .env.local.");
    }

    const client = new TwitterApi({
        appKey,
        appSecret,
        accessToken,
        accessSecret,
    });

    // Twitter hard limit is 280 characters. Truncate at a word boundary if needed.
    const TWITTER_MAX_CHARS = 280;
    let safeTweetText = tweetText.trim();
    if (safeTweetText.length > TWITTER_MAX_CHARS) {
        // Cut at last space before the limit to avoid splitting a word
        const cutoff = safeTweetText.lastIndexOf(" ", TWITTER_MAX_CHARS - 1);
        safeTweetText = (cutoff > 0 ? safeTweetText.slice(0, cutoff) : safeTweetText.slice(0, TWITTER_MAX_CHARS - 1)) + "…";
        console.log(`[publish] Tweet truncated to ${safeTweetText.length} chars (original: ${tweetText.length})`);
    }

    // Supported MIME types for Twitter media upload
    const TWITTER_SUPPORTED_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"];

    try {
        const rwClient = client.readWrite;

        let mediaId: string | undefined;
        if (imageUrl) {
            try {
                const imgRes = await fetch(imageUrl);
                if (!imgRes.ok) {
                    console.warn(`[publish] Failed to fetch image for Twitter: ${imgRes.statusText}`);
                } else {
                    const contentType = imgRes.headers.get("content-type") || "";
                    // Strip parameters like "; charset=utf-8" from the MIME type
                    const mimeType = contentType.split(";")[0].trim() || "image/jpeg";

                    if (!TWITTER_SUPPORTED_MIME.includes(mimeType)) {
                        console.warn(`[publish] Skipping Twitter media upload — unsupported type: ${mimeType}`);
                    } else {
                        const arrayBuffer = await imgRes.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);
                        mediaId = await client.v1.uploadMedia(buffer, { mimeType });
                        console.log(`[publish] Twitter media uploaded, id=${mediaId}`);
                    }
                }
            } catch (mediaErr: any) {
                console.warn(`[publish] Twitter media upload failed, falling back to text only:`, mediaErr.data?.detail || mediaErr.message || String(mediaErr));
            }
        }

        const tweetPayload: any = { text: safeTweetText };
        if (mediaId) {
            tweetPayload.media = { media_ids: [mediaId] };
        }

        const { data } = await rwClient.v2.tweet(tweetPayload);
        return data.id;
    } catch (e: any) {
        const errDetail: string = e.data?.detail || e.data?.title || e.message || String(e);
        // Twitter throws 403 "duplicate content" when the same tweet is posted twice.
        // This typically happens when the cron retries an attempt that already succeeded.
        // Treat it as already-published so we don't permanently mark the post as failed.
        if (errDetail.toLowerCase().includes("duplicate")) {
            console.warn(`[publish] Twitter duplicate content detected — post likely already published. Treating as success.`);
            return "already_published_duplicate";
        }
        throw new Error(`Twitter post failed: ${errDetail}`);
    }
}

export async function POST(req: Request) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return NextResponse.json({ success: false, error: "Supabase not configured" }, { status: 503 });
    }

    const body = await req.json() as { post_id: string; platforms: string[] };
    const { post_id, platforms } = body;

    if (!post_id || !platforms?.length) {
        return NextResponse.json({ success: false, error: "post_id and platforms are required" }, { status: 400 });
    }

    const [settings, postRes] = await Promise.all([
        getSettings(),
        fetch(`${SUPABASE_URL}/rest/v1/social_posts?id=eq.${encodeURIComponent(post_id)}&select=*`, {
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
            cache: "no-store",
        }),
    ]);

    const posts = await postRes.json();
    const post = posts[0];
    if (!post) {
        return NextResponse.json({ success: false, error: "Post not found" }, { status: 404 });
    }

    // Resolve credentials — env vars take priority
    const fbToken = cred("FB_TOKEN", settings.social_fb_token);
    const fbPageId = cred("FB_PAGE_ID", settings.social_fb_page_id);
    const igAccountId = cred("IG_ACCOUNT_ID", settings.social_ig_account_id);

    const currentPublishedTo: Record<string, boolean> = post.published_to || {};
    const results: Record<string, { success: boolean; post_id?: string; error?: string }> = {};

    if (platforms.includes("facebook")) {
        if (settings.social_fb_enabled !== "true") {
            results.facebook = { success: false, error: "Facebook publishing is disabled in settings." };
        } else if (!fbToken || !fbPageId) {
            results.facebook = { success: false, error: "Facebook token or page ID not configured." };
        } else {
            try {
                const fbPostId = await publishFacebook(fbToken, fbPageId, post.facebook || post.twitter || "", post.image_url ?? null);
                results.facebook = { success: true, post_id: fbPostId };
                currentPublishedTo.facebook = true;
            } catch (e: unknown) {
                results.facebook = { success: false, error: e instanceof Error ? e.message : String(e) };
            }
        }
    }

    if (platforms.includes("instagram")) {
        if (settings.social_ig_enabled !== "true") {
            results.instagram = { success: false, error: "Instagram publishing is disabled in settings." };
        } else if (!fbToken || !igAccountId) {
            results.instagram = { success: false, error: "Instagram credentials not configured." };
        } else {
            try {
                const igPostId = await publishInstagram(fbToken, igAccountId, post.instagram || post.facebook || "", post.image_url ?? null);
                results.instagram = { success: true, post_id: igPostId };
                currentPublishedTo.instagram = true;
            } catch (e: unknown) {
                results.instagram = { success: false, error: e instanceof Error ? e.message : String(e) };
            }
        }
    }

    if (platforms.includes("twitter")) {
        if (settings.social_twitter_enabled !== "true") {
            results.twitter = { success: false, error: "Twitter/X publishing is disabled in settings." };
        } else {
            try {
                const tweetId = await publishTwitter(settings, post.twitter || post.facebook || "", post.image_url ?? null);
                results.twitter = { success: true, post_id: tweetId };
                currentPublishedTo.twitter = true;
            } catch (e: unknown) {
                results.twitter = { success: false, error: e instanceof Error ? e.message : String(e) };
            }
        }
    }

    if (Object.values(results).some((r) => r.success)) {
        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?id=eq.${encodeURIComponent(post_id)}`, {
            method: "PATCH",
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
            },
            body: JSON.stringify({ published_to: currentPublishedTo }),
        });
        if (!patchRes.ok) {
            const patchErr = await patchRes.text().catch(() => patchRes.status.toString());
            console.error(`[publish] ❌ Supabase PATCH failed for post ${post_id}: ${patchErr}`);
        } else {
            console.log(`[publish] ✅ Supabase updated published_to for post ${post_id}:`, JSON.stringify(currentPublishedTo));
        }
    }

    const anySuccess = Object.values(results).some((r) => r.success);
    return NextResponse.json({ success: anySuccess, results, published_to: currentPublishedTo });
}

export async function GET(req: Request) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return NextResponse.json({ success: false, error: "Supabase not configured" }, { status: 503 });
    }

    const { searchParams } = new URL(req.url);
    const platform = searchParams.get("platform");

    if (!platform) {
        return NextResponse.json({ success: false, error: "platform query param required" }, { status: 400 });
    }

    const settings = await getSettings();

    try {
        if (platform === "facebook") {
            const token = cred("FB_TOKEN", settings.social_fb_token);
            const pageId = cred("FB_PAGE_ID", settings.social_fb_page_id);
            if (!token) throw new Error("Facebook token not configured.");
            const res = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(token)}&fields=id,name`);
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            // Also try getting the page token to verify access
            const pageTokenRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=name&access_token=${encodeURIComponent(token)}`);
            const pageData = await pageTokenRes.json();
            if (pageData.error) throw new Error(`Page access error: ${pageData.error.message}`);
            return NextResponse.json({ success: true, info: `User: ${data.name} | Page: ${pageData.name}` });
        }

        if (platform === "instagram") {
            const token = cred("FB_TOKEN", settings.social_fb_token);
            const igId = cred("IG_ACCOUNT_ID", settings.social_ig_account_id);
            if (!token || !igId) throw new Error("Instagram credentials not configured.");
            const res = await fetch(`https://graph.facebook.com/v21.0/${igId}?fields=id,username&access_token=${encodeURIComponent(token)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            return NextResponse.json({ success: true, info: `Connected as: @${data.username}` });
        }

        if (platform === "twitter") {
            const appKey = cred("TWITTER_API_KEY", settings.social_twitter_api_key);
            const appSecret = cred("TWITTER_API_SECRET", settings.social_twitter_api_secret);
            const accessToken = cred("TWITTER_ACCESS_TOKEN", settings.social_twitter_access_token);
            const accessSecret = cred("TWITTER_ACCESS_SECRET", settings.social_twitter_access_secret);
            
            if (!appKey || !appSecret || !accessToken || !accessSecret) {
                throw new Error("Twitter API credentials incomplete.");
            }
            
            const client = new TwitterApi({
                appKey,
                appSecret,
                accessToken,
                accessSecret,
            });
            
            try {
                const user = await client.v2.me();
                return NextResponse.json({ success: true, info: `Connected as: @${user.data.username}` });
            } catch (e: any) {
                throw new Error(e.data?.detail || e.message || "Failed to verify Twitter credentials.");
            }
        }

        return NextResponse.json({ success: false, error: "Unknown platform" }, { status: 400 });
    } catch (e: unknown) {
        return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
}
