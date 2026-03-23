import { NextRequest, NextResponse } from "next/server";

/**
 * Test API connectivity for a given provider.
 * Reads API keys from process.env (same .env file as the Python backend).
 *
 * Rate limited: max 1 request per provider per 10 seconds.
 */

type Provider = "linkup" | "parallel" | "tavily" | "exa" | "kie" | "gemini_flash";

// In-memory rate limiting: provider -> last test timestamp
const _lastTest: Record<string, number> = {};
const RATE_LIMIT_MS = 10_000; // 10 seconds

async function testLinkup(): Promise<{ latency_ms: number }> {
  const key = process.env.LINKUP_API_KEY;
  if (!key) throw new Error("LINKUP_API_KEY not set in environment.");
  const start = Date.now();
  const resp = await fetch("https://api.linkup.so/v1/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ q: "test", depth: "standard", outputType: "sourcedAnswer" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error(`Auth error: ${resp.status}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testParallel(): Promise<{ latency_ms: number }> {
  const key = process.env.PARALLEL_API_KEY;
  if (!key) throw new Error("PARALLEL_API_KEY not set in environment.");
  const start = Date.now();
  const resp = await fetch("https://api.parallel.ai/v1beta/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,           // Parallel AI uses x-api-key, NOT Authorization Bearer
    },
    body: JSON.stringify({
      objective: "test connectivity",
      search_queries: ["test"],
      mode: "fast",
      excerpts: { max_chars_per_result: 100 },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error(`Auth error: ${resp.status}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testTavily(): Promise<{ latency_ms: number }> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY not set in environment.");
  const start = Date.now();
  const resp = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: ["https://example.com"], extract_depth: "basic" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error(`Auth error: ${resp.status}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testExa(): Promise<{ latency_ms: number }> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY not set in environment.");
  const start = Date.now();
  const resp = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["https://example.com"], text: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error(`Auth error: ${resp.status}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testKie(): Promise<{ latency_ms: number }> {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("KIE_API_KEY not set in environment.");
  const start = Date.now();
  // Use account info endpoint to verify auth without actually generating an image
  const resp = await fetch("https://api.kie.ai/api/v1/user/info", {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error(`Auth error: ${resp.status}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

async function testGeminiFlash(): Promise<{ latency_ms: number }> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error("AI_GATEWAY_API_KEY not set in environment.");
  const start = Date.now();
  const resp = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: "Say 'ok' only." }],
      max_tokens: 5,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error(`Auth error: ${resp.status}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return { latency_ms: Date.now() - start };
}

const PROVIDER_TESTS: Record<Provider, () => Promise<{ latency_ms: number }>> = {
  linkup: testLinkup,
  parallel: testParallel,
  tavily: testTavily,
  exa: testExa,
  kie: testKie,
  gemini_flash: testGeminiFlash,
};

export async function POST(request: NextRequest) {
  let provider: Provider;
  try {
    const body = await request.json();
    provider = body.provider as Provider;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!provider || !PROVIDER_TESTS[provider]) {
    return NextResponse.json(
      { success: false, error: `Unknown provider: ${provider}. Valid: ${Object.keys(PROVIDER_TESTS).join(", ")}` },
      { status: 400 }
    );
  }

  // Rate limit: 1 request per provider per 10s
  const now = Date.now();
  const last = _lastTest[provider] ?? 0;
  const elapsed = now - last;
  if (elapsed < RATE_LIMIT_MS) {
    const wait = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
    return NextResponse.json(
      { success: false, error: `Rate limited. Wait ${wait}s before testing ${provider} again.` },
      { status: 429 }
    );
  }

  _lastTest[provider] = now;

  try {
    const { latency_ms } = await PROVIDER_TESTS[provider]();
    return NextResponse.json({ success: true, latency_ms, provider });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message, provider }, { status: 200 });
  }
}
