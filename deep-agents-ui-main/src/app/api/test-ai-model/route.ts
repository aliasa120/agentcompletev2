import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/test-ai-model — returns env key status + custom models from DB
export async function GET() {
  let ninerouter_key = "";
  try {
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "ninerouter_client_api_key")
      .single();
    if (data?.value) {
      ninerouter_key = data.value.trim();
    }
  } catch {}

  const env_status: Record<string, boolean> = {};

  // Dynamically load all free/noAuth provider aliases from the 9Router source code folder
  try {
    const registryDir = path.join(process.cwd(), "../9router-master/open-sse/providers/registry");
    if (fs.existsSync(registryDir)) {
      const files = fs.readdirSync(registryDir);
      for (const file of files) {
        if (file.endsWith(".js") && file !== "index.js") {
          const content = fs.readFileSync(path.join(registryDir, file), "utf8");
          const idMatch = content.match(/id:\s*["']([^"']+)["']/);
          const aliasMatch = content.match(/alias:\s*["']([^"']+)["']/);
          const noAuthMatch = content.match(/noAuth:\s*true/);
          if (idMatch && noAuthMatch) {
            const alias = aliasMatch ? aliasMatch[1] : idMatch[1];
            env_status[alias.toLowerCase()] = true;
          }
        }
      }
    }
  } catch (err) {
    console.error("Failed to load noAuth providers in test-ai-model status check:", err);
  }
  
  if (ninerouter_key) {
    env_status["ninerouter"] = true;
    try {
      const nineRouterBaseUrl = process.env.NEXT_PUBLIC_NINE_ROUTER_URL || "http://localhost:20128";
      const res = await fetch(`${nineRouterBaseUrl}/v1/models`, {
        headers: { "Authorization": `Bearer ${ninerouter_key}` }
      });
      const d = await res.json();
      const models = d.data || [];
      for (const m of models) {
        const parts = m.id.split("/");
        if (parts.length > 1) {
          env_status[parts[0].toLowerCase()] = true;
        }
      }
    } catch (err) {
      console.error("Failed to query 9Router inside test-ai-model status:", err);
    }
  }

  const PROVIDER_STATUS_KEYS: Record<string, string> = {
    vercel:      "AI_GATEWAY_API_KEY",
    openai:      "OPENAI_API_KEY",
    anthropic:   "ANTHROPIC_API_KEY",
    google:      "GOOGLE_API_KEY",
    openrouter:  "OPENROUTER_API_KEY",
    litellm:     "LITELLM_API_KEY",
    groq:        "GROQ_API_KEY",
    together:    "TOGETHER_API_KEY",
    nvidia:      "NVIDIA_API_KEY",
    mimo:        "MIMO_API_KEY",
    novita:      "NOVITA_API_KEY",
    opencode:    "OPENCODE_API_KEY",
    deepseek:    "DEEPSEEK_API_KEY",
  };

  for (const [pid, envKey] of Object.entries(PROVIDER_STATUS_KEYS)) {
    if (env_status[pid] === undefined) {
      env_status[pid] = !!(process.env[envKey]);
    }
  }

  let custom_models: Record<string, string[]> = {};
  try {
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "custom_models_by_provider")
      .single();
    if (data?.value) custom_models = JSON.parse(data.value);
  } catch { /* no saved custom models yet */ }

  return NextResponse.json({ env_status, custom_models });
}

// PATCH /api/test-ai-model — save custom models for one provider
export async function PATCH(req: Request) {
  try {
    const { provider_id, custom_models } = await req.json();
    if (!provider_id) return NextResponse.json({ error: "provider_id required" }, { status: 400 });

    let existing: Record<string, string[]> = {};
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "custom_models_by_provider")
      .single();
    if (data?.value) { try { existing = JSON.parse(data.value); } catch { /* ignore */ } }

    const updated = { ...existing, [provider_id]: custom_models ?? [] };
    await supabase.from("agent_settings").upsert(
      { key: "custom_models_by_provider", value: JSON.stringify(updated) },
      { onConflict: "key" }
    );
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}

// Provider → env var name (mirrors provider_registry.py)
const PROVIDER_ENV_KEYS: Record<string, string> = {
  vercel:     "AI_GATEWAY_API_KEY",
  openai:     "OPENAI_API_KEY",
  anthropic:  "ANTHROPIC_API_KEY",
  google:     "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  litellm:    "LITELLM_API_KEY",
  groq:       "GROQ_API_KEY",
  together:   "TOGETHER_API_KEY",
  nvidia:     "NVIDIA_API_KEY",
  mimo:       "MIMO_API_KEY",
  novita:     "NOVITA_API_KEY",
  opencode:   "OPENCODE_API_KEY",
  deepseek:   "DEEPSEEK_API_KEY",
};

// Provider → base URL (mirrors provider_registry.py)
const PROVIDER_BASE_URLS: Record<string, string> = {
  vercel:     "https://ai-gateway.vercel.sh/v1",
  openai:     "https://api.openai.com/v1",
  anthropic:  "https://api.anthropic.com/v1",
  google:     "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  litellm:    "",
  groq:       "https://api.groq.com/openai/v1",
  together:   "https://api.together.xyz/v1",
  nvidia:     "https://integrate.api.nvidia.com/v1",
  mimo:       "https://api.xiaomimimo.com/v1",
  novita:     "https://api.novita.ai/openai/v1",
  opencode:   "https://opencode.ai/zen/v1",
  deepseek:   "https://api.deepseek.com",
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

  let resolvedKey = "";
  let resolvedBase = "";

  // Check if we have 9Router Client API Key configured
  let ninerouter_key = "";
  try {
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "ninerouter_client_api_key")
      .single();
    if (data?.value) {
      ninerouter_key = data.value.trim();
    }
  } catch {}

  if (ninerouter_key) {
    resolvedKey = ninerouter_key;
    resolvedBase = process.env.NEXT_PUBLIC_NINE_ROUTER_URL || "http://localhost:20128/v1";
  } else {
    if (provider === "litellm") {
      resolvedBase = customBaseUrl || process.env.LITELLM_BASE_URL || "http://47.82.164.26:4000";
      if (!resolvedBase.endsWith("/v1")) resolvedBase = resolvedBase + "/v1";
    } else {
      resolvedBase = PROVIDER_BASE_URLS[provider] ?? "https://ai-gateway.vercel.sh/v1";
    }
    const envKeyName = PROVIDER_ENV_KEYS[provider];
    resolvedKey = envKeyName ? (process.env[envKeyName] ?? "") : "";
  }

  if (!resolvedKey) {
    return NextResponse.json(
      {
        success: false,
        error: ninerouter_key 
          ? "No client API key configured."
          : `No API key set for provider "${provider}". Add ${PROVIDER_ENV_KEYS[provider] ?? "the env var"} to your .env file and restart the server.`,
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
    const timeoutMs = provider === "nvidia" ? 90_000 : 60_000;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resolvedKey}`,
        "Content-Type": "application/json",
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
