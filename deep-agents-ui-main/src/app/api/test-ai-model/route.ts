import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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

// GET /api/test-ai-model — returns env key status + custom models from DB
export async function GET() {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const env_status: Record<string, boolean> = {};

  let openrouter_key = "";
  try {
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "openrouter_client_api_key")
      .single();
    if (data?.value) {
      openrouter_key = data.value.trim();
    }
  } catch {}

  let gemini_key = "";
  try {
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "gemini_client_api_key")
      .single();
    if (data?.value) {
      gemini_key = data.value.trim();
    }
  } catch {}

  env_status["openrouter"] = !!(openrouter_key || process.env.OPENROUTER_API_KEY);
  env_status["gemini"] = !!(gemini_key || process.env.GEMINI_API_KEY);

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
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
      { key: "custom_models_by_provider", value: JSON.stringify(updated), user_id: user.id },
      { onConflict: "user_id,key" }
    );
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}

const PROVIDER_ENDPOINTS: Record<string, { baseUrl: string; keyName: string; envKey: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyName: "openrouter_client_api_key", envKey: "OPENROUTER_API_KEY" },
  gemini:     { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyName: "gemini_client_api_key", envKey: "GEMINI_API_KEY" },
  grok:       { baseUrl: "https://api.x.ai/v1", keyName: "grok_client_api_key", envKey: "XAI_API_KEY" },
  together:   { baseUrl: "https://api.together.xyz/v1", keyName: "together_client_api_key", envKey: "TOGETHER_API_KEY" },
  cerebras:   { baseUrl: "https://api.cerebras.ai/v1", keyName: "cerebras_client_api_key", envKey: "CEREBRAS_API_KEY" },
  groq:       { baseUrl: "https://api.groq.com/openai/v1", keyName: "groq_client_api_key", envKey: "GROQ_API_KEY" },
  deepseek:   { baseUrl: "https://api.deepseek.com/v1", keyName: "deepseek_client_api_key", envKey: "DEEPSEEK_API_KEY" },
  mistral:    { baseUrl: "https://api.mistral.ai/v1", keyName: "mistral_client_api_key", envKey: "MISTRAL_API_KEY" },
  fireworks:  { baseUrl: "https://api.fireworks.ai/inference/v1", keyName: "fireworks_client_api_key", envKey: "FIREWORKS_API_KEY" },
  ollama:     { baseUrl: "http://localhost:11434/v1", keyName: "ollama_client_api_key", envKey: "OLLAMA_API_KEY" },
};

// POST /api/test-ai-model — execute test model call
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  let provider: string;
  let model: string;
  let customBaseUrl: string = "";
  let customApiKey: string = "";

  try {
    const body = await request.json();
    provider      = (body.provider ?? "openrouter").trim().toLowerCase();
    model         = (body.model    ?? "").trim();
    customBaseUrl = (body.base_url ?? "").trim();
    customApiKey  = (body.api_key  ?? "").trim();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!model) {
    return NextResponse.json({ success: false, error: "model is required." }, { status: 400 });
  }

  // Load all user settings from DB
  let settingsMap = new Map<string, string>();
  let customAiProviders: any[] = [];
  try {
    const { data: settings } = await supabase
      .from("agent_settings")
      .select("key, value");
    settingsMap = new Map((settings || []).map(s => [s.key, s.value]));

    const rawCustom = settingsMap.get("custom_ai_providers");
    if (rawCustom) {
      try { customAiProviders = JSON.parse(rawCustom); } catch {}
    }
  } catch {}

  let resolvedKey = customApiKey;
  let baseUrl = customBaseUrl;
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  const builtin = PROVIDER_ENDPOINTS[provider];
  if (builtin) {
    baseUrl = builtin.baseUrl;
    if (provider === "ollama") {
      const dbOllamaBase = settingsMap.get("ollama_base_url")?.trim();
      if (dbOllamaBase) baseUrl = dbOllamaBase;
      else if (process.env.OLLAMA_BASE_URL) baseUrl = process.env.OLLAMA_BASE_URL;
    }

    if (!resolvedKey) {
      resolvedKey = settingsMap.get(builtin.keyName)?.trim() || process.env[builtin.envKey] || "";
    }

    if (provider !== "ollama" && !resolvedKey) {
      return NextResponse.json(
        { success: false, error: `No API key configured for ${provider}. Please add it in ENV Keys or AI Providers.`, provider, model },
        { status: 400 }
      );
    }
  } else {
    // Check if custom provider
    const foundCustom = customAiProviders.find((cp: any) => cp.id === provider);
    if (foundCustom) {
      baseUrl = foundCustom.base_url || foundCustom.baseUrl || baseUrl;
      if (!resolvedKey) {
        resolvedKey = foundCustom.api_key || foundCustom.apiKey || "";
      }
    }
  }

  if (!baseUrl) {
    baseUrl = "https://openrouter.ai/api/v1";
  }

  if (resolvedKey) {
    headers["Authorization"] = `Bearer ${resolvedKey}`;
  }
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost:3000";
    headers["X-Title"] = "AgentComplete";
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  // Strip provider prefix from model if present (e.g. "openrouter/...")
  let cleanModel = model;
  if (cleanModel.startsWith(`${provider}/`)) {
    cleanModel = cleanModel.slice(`${provider}/`.length);
  }

  const start = Date.now();
  console.log(`[test-ai-model] → ${provider} | ${cleanModel} | ${endpoint}`);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cleanModel,
        messages: [{ role: "user", content: "Reply with one word: ok" }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const latency_ms = Date.now() - start;

    if (!resp.ok) {
      let errText = "";
      try { errText = await resp.text(); } catch { /* ignore */ }
      const short = errText.slice(0, 250);
      console.log(`[test-ai-model] ✗ HTTP ${resp.status} in ${latency_ms}ms: ${short}`);
      return NextResponse.json({
        success: false,
        error: `HTTP ${resp.status}${short ? ": " + short : ""}`,
        latency_ms,
        provider,
        model,
      });
    }

    console.log(`[test-ai-model] ✓ ${latency_ms}ms — ${cleanModel} OK`);
    return NextResponse.json({ success: true, latency_ms, provider, model: cleanModel });

  } catch (err: unknown) {
    const latency_ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[test-ai-model] ✗ Error in ${latency_ms}ms: ${message}`);
    return NextResponse.json({ success: false, error: message, latency_ms, provider, model: cleanModel });
  }
}
