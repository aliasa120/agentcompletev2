import { NextResponse } from "next/server";

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

async function loginTwitter(
    apiKey: string,
    username: string,
    email: string,
    password: string,
    proxy: string,
    totp: string
): Promise<string> {
    const payload: Record<string, string> = { user_name: username, email, password };
    if (proxy) payload.proxy = proxy;
    if (totp) payload.totp_secret = totp;
    const loginRes = await fetch("https://api.twitterapi.io/twitter/user_login_v2", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify(payload),
    });
    const loginData = await loginRes.json();
    console.error("[twitter-login] response:", JSON.stringify(loginData));
    if (loginData.status !== "success" || !loginData.login_cookie) {
        const detail = loginData.msg || loginData.message || loginData.error || JSON.stringify(loginData);
        throw new Error(`Twitter login failed: ${detail}`);
    }
    return loginData.login_cookie;
}

async function publishTwitter(
    settings: Record<string, string>,
    tweetText: string
): Promise<string> {
    const apiKey = cred("TWITTER_API_KEY", settings.social_twitter_api_key);
    const username = cred("TWITTER_USERNAME", settings.social_twitter_username);
    const email = cred("TWITTER_EMAIL", settings.social_twitter_email);
    const password = cred("TWITTER_PASSWORD", settings.social_twitter_password);
    const proxy = cred("TWITTER_PROXY", settings.social_twitter_proxy);
    const totp = cred("TWITTER_TOTP", settings.social_twitter_totp);

    if (!apiKey || !username || !email || !password) {
        throw new Error("Twitter credentials incomplete (API key, username, email, password required). Configure them in .env.local.");
    }

    let loginCookie = settings.social_twitter_cookie || "";

    if (!loginCookie) {
        loginCookie = await loginTwitter(apiKey, username, email, password, proxy, totp);
        await upsertSetting("social_twitter_cookie", loginCookie);
    }

    const doTweet = async (cookie: string) => {
        const payload: Record<string, string> = { login_cookies: cookie, tweet_text: tweetText };
        if (proxy) payload.proxy = proxy;
        const res = await fetch("https://api.twitterapi.io/twitter/create_tweet_v2", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
            body: JSON.stringify(payload),
        });
        return res.json();
    };

    let tweetData = await doTweet(loginCookie);

    if (tweetData.status !== "success") {
        const msg = (tweetData.msg || "").toLowerCase();
        if (msg.includes("cookie") || msg.includes("expired") || msg.includes("login")) {
            await upsertSetting("social_twitter_cookie", "");
            loginCookie = await loginTwitter(apiKey, username, email, password, proxy, totp);
            await upsertSetting("social_twitter_cookie", loginCookie);
            tweetData = await doTweet(loginCookie);
        }
        if (tweetData.status !== "success") {
            throw new Error(`Twitter post failed: ${tweetData.msg || "Unknown error"}`);
        }
    }

    return tweetData.tweet_id;
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
                const tweetId = await publishTwitter(settings, post.twitter || post.facebook || "");
                results.twitter = { success: true, post_id: tweetId };
                currentPublishedTo.twitter = true;
            } catch (e: unknown) {
                results.twitter = { success: false, error: e instanceof Error ? e.message : String(e) };
            }
        }
    }

    if (Object.values(results).some((r) => r.success)) {
        await fetch(`${SUPABASE_URL}/rest/v1/social_posts?id=eq.${encodeURIComponent(post_id)}`, {
            method: "PATCH",
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
            },
            body: JSON.stringify({ published_to: currentPublishedTo }),
        });
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
            const apiKey = cred("TWITTER_API_KEY", settings.social_twitter_api_key);
            const username = cred("TWITTER_USERNAME", settings.social_twitter_username);
            if (!apiKey || !username) throw new Error("Twitter API key or username not configured.");
            const res = await fetch(`https://api.twitterapi.io/twitter/user/info?userName=${username}`, {
                headers: { "x-api-key": apiKey },
            });
            const data = await res.json();
            if (data.status === "error") throw new Error(data.msg || "Failed to get Twitter user info.");
            return NextResponse.json({ success: true, info: `Connected as: @${username}` });
        }

        return NextResponse.json({ success: false, error: "Unknown platform" }, { status: 400 });
    } catch (e: unknown) {
        return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
}
