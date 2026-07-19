import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

type Provider =
  | "openrouter"
  | "gemini"
  | "tavily"
  | "linkup"
  | "exa"
  | "brave";

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

const PROVIDER_KEY_MAP: Record<Provider, string> = {
  openrouter: "openrouter_client_api_key",
  gemini: "gemini_client_api_key",
  tavily: "tavily_api_key",
  linkup: "linkup_api_key",
  exa: "exa_api_key",
  brave: "brave_api_key",
};

const PROVIDER_TEST_FUNCS: Record<Provider, (key: string) => Promise<{ latency_ms: number }>> = {
  openrouter: testOpenRouter,
  gemini: testGemini,
  tavily: testTavily,
  linkup: testLinkup,
  exa: testExa,
  brave: testBrave,
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
  try {
    const body = await request.json();
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

  // Retrieve key from user settings
  const key = await getUserKey(supabase, user.id, keyName);
  if (!key) {
    return NextResponse.json({
      success: false,
      error: `API key for ${provider} (${keyName}) is not set in your settings. Please save it first.`,
    });
  }

  try {
    const { latency_ms } = await testFunc(key);
    return NextResponse.json({ success: true, latency_ms });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message || "Test connection failed" });
  }
}
