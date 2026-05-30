import { NextRequest, NextResponse } from "next/server";

/**
 * Test any AI model (Vercel AI Gateway or LiteLLM).
 * Server-side only — API keys never appear in browser network traffic.
 *
 * No rate limiting — the caller is responsible for debouncing.
 * 60-second timeout to handle slow LiteLLM responses.
 */
export async function POST(request: NextRequest) {
  let provider: string;
  let model: string;
  let apiKey: string;
  let baseUrl: string;

  try {
    const body = await request.json();
    provider = (body.provider ?? "vercel").trim().toLowerCase();
    model    = (body.model    ?? "").trim();
    apiKey   = (body.apiKey  ?? "").trim();
    baseUrl  = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!model) {
    return NextResponse.json({ success: false, error: "model is required." }, { status: 400 });
  }

  // ── Resolve endpoint ──────────────────────────────────────────────────────
  let resolvedBase: string;
  if (provider === "litellm") {
    resolvedBase = baseUrl || process.env.LITELLM_BASE_URL || "http://47.82.164.26:4000";
    // LiteLLM exposes /v1/chat/completions (OpenAI-compatible)
    if (!resolvedBase.endsWith("/v1")) resolvedBase = resolvedBase + "/v1";
  } else {
    // Vercel AI Gateway
    resolvedBase = "https://ai-gateway.vercel.sh/v1";
  }

  // ── Resolve API key ───────────────────────────────────────────────────────
  const resolvedKey =
    apiKey ||                               // from UI (takes priority)
    (provider === "litellm"
      ? process.env.LITELLM_API_KEY ?? ""
      : process.env.AI_GATEWAY_API_KEY ?? "");

  if (!resolvedKey) {
    return NextResponse.json(
      { success: false, error: `No API key available for provider "${provider}". Enter one in the API Keys section above.` },
      { status: 400 }
    );
  }

  const endpoint = `${resolvedBase}/chat/completions`;
  const start = Date.now();

  console.log(`[test-ai-model] → ${provider} | ${model} | ${endpoint}`);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolvedKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with one word: ok" }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),  // 60s — LiteLLM can be slow
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
