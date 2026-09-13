import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { TwitterApi } from "twitter-api-v2";

type Provider =
  | "openrouter"
  | "gemini"
  | "tavily"
  | "linkup"
  | "exa"
  | "brave"
  | "vercel"
  | "grok_imagine"
  | "twitter"
  | "buffer";

// In-memory rate limiting: provider -> last test timestamp
const _lastTest: Record<string, number> = {};
const RATE_LIMIT_MS = 5000; // 5 seconds for convenience

function getSupabaseClient(cookieStore: any) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
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

// Helper to fetch key from Supabase agent_settings for the user
async function getUserKey(supabase: any, userId: string, keyName: string): Promise<string> {
  const { data, error } = await supabase
    .from("agent_settings")
    .select("value")
    .eq("user_id", userId)
    .eq("key", keyName)
    .maybeSingle();

  if (error) {
    console.error(`Error loading key ${keyName}:`, error);
    return "";
  }
  return data?.value?.trim() || "";
}

// ── Test Implementations ───────────────────────────────────────────────────────

async function testOpenRouter(key: string): Promise<{ latency_ms: number }> {
  const start = Date.now();
  const resp = await fetch("https://openrouter.ai/api/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("Invalid OpenRouter key");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testGemini(key: string): Promise<{ latency_ms: number }> {
  const start = Date.now();
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 400 || resp.status === 403) throw new Error("Invalid Gemini API key");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testTavily(key: string): Promise<{ latency_ms: number }> {
  const start = Date.now();
  const resp = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: ["https://example.com"], extract_depth: "basic" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("Invalid Tavily key");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testLinkup(key: string): Promise<{ latency_ms: number }> {
  const start = Date.now();
  const resp = await fetch("https://api.linkup.so/v1/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ q: "test", depth: "standard", outputType: "sourcedAnswer" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("Invalid Linkup key");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testExa(key: string): Promise<{ latency_ms: number }> {
  const start = Date.now();
  const resp = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["https://example.com"], text: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("Invalid Exa AI key");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testBrave(key: string): Promise<{ latency_ms: number }> {
  const start = Date.now();
  const resp = await fetch("https://api.search.brave.com/res/v1/web/search?q=test", {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("Invalid Brave Search key");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testVercelGateway(key: string): Promise<{ latency_ms: number }> {
  const start = Date.now();
  const resp = await fetch("https://ai-gateway.vercel.sh/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error("Invalid Vercel AI Gateway API key");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testTwitter(key: string, supabase?: any, userId?: string): Promise<{ latency_ms: number; message?: string }> {
  let appSecret = process.env.TWITTER_API_SECRET || "";
  let accessToken = process.env.TWITTER_ACCESS_TOKEN || "";
  let accessSecret = process.env.TWITTER_ACCESS_SECRET || "";

  if (supabase && userId) {
    const userSecret = (await getUserKey(supabase, userId, "social_twitter_api_secret")) ||
                       (await getUserKey(supabase, userId, "twitter_api_secret"));
    const userToken = (await getUserKey(supabase, userId, "social_twitter_access_token")) ||
                      (await getUserKey(supabase, userId, "twitter_access_token"));
    const userAccessSecret = (await getUserKey(supabase, userId, "social_twitter_access_secret")) ||
                             (await getUserKey(supabase, userId, "twitter_access_secret"));
    if (userSecret) appSecret = userSecret;
    if (userToken) accessToken = userToken;
    if (userAccessSecret) accessSecret = userAccessSecret;
  }

  if (!appSecret || !accessToken || !accessSecret) {
    throw new Error("Missing X credentials. Please save API Key Secret, Access Token, and Access Token Secret first.");
  }

  const start = Date.now();
  const client = new TwitterApi({
    appKey: key,
    appSecret,
    accessToken,
    accessSecret,
  });

  const me = await client.v2.me();
  const latency_ms = Date.now() - start;
  if (!me?.data?.username) {
    throw new Error("Could not verify account identity with X API v2.");
  }
  return { latency_ms, message: `@${me.data.username}` };
}

async function testBuffer(key: string): Promise<{ latency_ms: number; message?: string }> {
  const start = Date.now();
  const trimmedKey = key.trim();

  // 1. Fetch account and organizations info (valid on all plans including Free)
  const resp = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${trimmedKey}`,
    },
    body: JSON.stringify({
      query: `query TestBufferAccount {
        account {
          id
          email
          name
          organizations {
            id
            name
            channelCount
          }
        }
      }`,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Invalid or expired Buffer token. Please verify your Personal API Key from publish.buffer.com/settings/api.");
  }

  const json = await resp.json().catch(() => ({}));
  if (json.errors?.length) {
    const rawMsg = json.errors[0].message || "";
    if (rawMsg.toLowerCase().includes("not authorized") || rawMsg.toLowerCase().includes("unauthenticated")) {
      throw new Error("Buffer returned 'Not authorized'. Please generate a new Personal Access Key at publish.buffer.com/settings/api and paste it here.");
    }
    throw new Error(rawMsg);
  }

  const account = json.data?.account;
  if (!account) {
    throw new Error("Could not load Buffer account data. Please check your token permissions.");
  }

  const orgs = account.organizations || [];
  const orgId = orgs[0]?.id;
  let channelSummary = "";

  // 2. Discover channels if organization exists
  if (orgId) {
    try {
      const chResp = await fetch("https://api.buffer.com", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${trimmedKey}`,
        },
        body: JSON.stringify({
          query: `query GetOrgChannels($input: ChannelsInput!) {
            channels(input: $input) {
              id
              name
              service
            }
          }`,
          variables: { input: { organizationId: orgId } },
        }),
        signal: AbortSignal.timeout(6_000),
      });
      const chJson = await chResp.json().catch(() => ({}));
      const channels = chJson.data?.channels || [];
      if (channels.length > 0) {
        const services = [...new Set(channels.map((c: any) => c.service).filter(Boolean))];
        channelSummary = `${channels.length} channel${channels.length > 1 ? "s" : ""} (${services.join(", ")})`;
      }
    } catch {
      // Non-fatal if channel fetch fails; account is already verified
    }
  }

  const latency_ms = Date.now() - start;
  const identifier = account.email || account.name || "Buffer Account";
  const message = channelSummary
    ? `Connected: ${identifier} — ${channelSummary}`
    : `Connected: ${identifier}`;

  return { latency_ms, message };
}

const PROVIDER_KEY_MAP: Record<Provider, string> = {
  openrouter: "openrouter_client_api_key",
  gemini: "gemini_client_api_key",
  tavily: "tavily_api_key",
  linkup: "linkup_api_key",
  exa: "exa_api_key",
  brave: "brave_api_key",
  vercel: "ai_gateway_api_key",
  grok_imagine: "ai_gateway_api_key",
  twitter: "social_twitter_api_key",
  buffer: "buffer_access_token",
};

const PROVIDER_TEST_FUNCS: Record<Provider, (key: string, supabase?: any, userId?: string) => Promise<{ latency_ms: number; message?: string }>> = {
  openrouter: testOpenRouter,
  gemini: testGemini,
  tavily: testTavily,
  linkup: testLinkup,
  exa: testExa,
  brave: testBrave,
  vercel: testVercelGateway,
  grok_imagine: testVercelGateway,
  twitter: testTwitter,
  buffer: testBuffer,
};

export async function POST(request: NextRequest) {
  // Auth check
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let provider: Provider;
  let body: any;
  try {
    body = await request.json();
    provider = body.provider as Provider;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const keyName = PROVIDER_KEY_MAP[provider];
  const testFunc = PROVIDER_TEST_FUNCS[provider];

  if (!provider || !keyName || !testFunc) {
    return NextResponse.json(
      { success: false, error: `Unsupported test provider: ${provider}` },
      { status: 400 }
    );
  }

  // Rate limit
  const now = Date.now();
  const last = _lastTest[`${user.id}:${provider}`] ?? 0;
  const elapsed = now - last;
  if (elapsed < RATE_LIMIT_MS) {
    const wait = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
    return NextResponse.json(
      { success: false, error: `Wait ${wait}s before testing ${provider} again.` },
      { status: 429 }
    );
  }
  _lastTest[`${user.id}:${provider}`] = now;

  // Retrieve key from request body (live test without saving) or user settings
  const bodyKey = typeof (body as any).key === "string" ? (body as any).key.trim() : "";
  let key = bodyKey || (await getUserKey(supabase, user.id, keyName));
  if (!key && provider === "twitter") {
    key = (await getUserKey(supabase, user.id, "twitter_api_key")) || process.env.TWITTER_API_KEY || "";
  }
  if (!key) {
    return NextResponse.json({
      success: false,
      error: `API key for ${provider} (${keyName}) is not set. Please enter or save your key first.`,
    });
  }

  try {
    const result = await testFunc(key, supabase, user.id);
    return NextResponse.json({ success: true, latency_ms: result.latency_ms, message: result.message });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || "Test connection failed" });
  }
}
