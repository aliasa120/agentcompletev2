import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/test-ai-model
 *
 * Test any AI model by sending a single "Reply with one word: ok" completion.
 * Server-side only — API keys come from env vars, never from the request body.
 *
 * Body: { provider: string, model: string, baseUrl?: string }
 *   - provider: one of "vercel" | "openai" | "anthropic" | "openrouter" | "litellm" | "groq" | "together"
 *   - model: the model identifier string
 *   - baseUrl: optional override (used for custom LiteLLM base URLs from Supabase)
 *
 * The apiKey field is intentionally NOT accepted in the request body.
 * This prevents key exposure in browser network traffic.
 */

// Provider → env var name (mirrors provider_registry.py)
const PROVIDER_ENV_KEYS: Record<string, string> = {
  vercel:     "AI_GATEWAY_API_KEY",
  openai:     "OPENAI_API_KEY",
  anthropic:  "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  litellm:    "LITELLM_API_KEY",
  groq:       "GROQ_API_KEY",
  together:   "TOGETHER_API_KEY",
  nvidia:     "NVIDIA_API_KEY",
  mimo:       "MIMO_API_KEY",
};

// Provider → base URL (mirrors provider_registry.py)
const PROVIDER_BASE_URLS: Record<string, string> = {
  vercel:     "https://ai-gateway.vercel.sh/v1",
  openai:     "https://api.openai.com/v1",
  anthropic:  "https://api.anthropic.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  litellm:    "", // dynamic — from LITELLM_BASE_URL env or request baseUrl
  groq:       "https://api.groq.com/openai/v1",
  together:   "https://api.together.xyz/v1",
  nvidia:     "https://integrate.api.nvidia.com/v1",
  mimo:       "https://api.xiaomimimo.com/v1",
};

export async function POST(request: NextRequest) {
  let provider: string;
  let model: string;
  let customBaseUrl: string;

  try {
    const body = await request.json();
    provider      = (body.provider ?? "vercel").trim().toLowerCase();
    model         = (body.model    ?? "").trim();
    customBaseUrl = (body.baseUrl  ?? "").trim().replace(/\/+$/, "");
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!model) {
    return NextResponse.json({ success: false, error: "model is required." }, { status: 400 });
  }

  // ── Resolve endpoint (env-first, never from request body) ─────────────────
  let resolvedBase: string;

  if (provider === "litellm") {
    resolvedBase = customBaseUrl
      || process.env.LITELLM_BASE_URL
      || "http://47.82.164.26:4000";
    if (!resolvedBase.endsWith("/v1")) resolvedBase = resolvedBase + "/v1";
  } else {
    resolvedBase = PROVIDER_BASE_URLS[provider] ?? "https://ai-gateway.vercel.sh/v1";
  }

  // ── Resolve API key from env ONLY ─────────────────────────────────────────
  const envKeyName = PROVIDER_ENV_KEYS[provider];
  const resolvedKey = envKeyName ? (process.env[envKeyName] ?? "") : "";

  if (!resolvedKey) {
    return NextResponse.json(
      {
        success: false,
        error: `No API key set for provider "${provider}". Add ${envKeyName ?? "the env var"} to your .env file and restart the server.`,
        provider,
        model,
      },
      { status: 400 }
    );
  }

  const endpoint = `${resolvedBase}/chat/completions`;
  const start = Date.now();

  console.log(`[test-ai-model] → ${provider} | ${model} | ${endpoint}`);

  try {
    const timeoutMs = provider === "nvidia" ? 90_000 : 60_000; // NIM cold-starts take 60-90s
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolvedKey}`,
        "Content-Type": "application/json",
        // OpenRouter requires a site URL header
        ...(provider === "openrouter" ? { "HTTP-Referer": "http://localhost:3000" } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with one word: ok" }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const latency_ms = Date.now() - start;

    if (!resp.ok) {
      let errText = "";
      try { errText = await resp.text(); } catch { /* ignore */ }
      const short = errText.slice(0, 200);

      console.log(`[test-ai-model] ✗ HTTP ${resp.status} in ${latency_ms}ms: ${short}`);

      return NextResponse.json({
        success: false,
        error: `HTTP ${resp.status}${short ? ": " + short : ""}`,
        latency_ms,
        provider,
        model,
      });
    }

    console.log(`[test-ai-model] ✓ ${latency_ms}ms — ${model} OK`);
    return NextResponse.json({ success: true, latency_ms, provider, model });

  } catch (err: unknown) {
    const latency_ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[test-ai-model] ✗ Error in ${latency_ms}ms: ${message}`);
    return NextResponse.json({ success: false, error: message, latency_ms, provider, model });
  }
}
