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

// POST /api/test-ai-model — execute test model call
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  let provider: string;
  let model: string;

  try {
    const body = await request.json();
    provider      = (body.provider ?? "openrouter").trim().toLowerCase();
    model         = (body.model    ?? "").trim();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!model) {
    return NextResponse.json({ success: false, error: "model is required." }, { status: 400 });
  }

  let resolvedKey = "";
  let endpoint = "";
  let headers: Record<string, string> = { "Content-Type": "application/json" };

  if (provider === "gemini") {
    try {
      const { data } = await supabase
        .from("agent_settings")
        .select("value")
        .eq("key", "gemini_client_api_key")
        .single();
      if (data?.value) {
        resolvedKey = data.value.trim();
      }
    } catch {}

    if (!resolvedKey) {
      resolvedKey = process.env.GEMINI_API_KEY || "";
    }

    if (!resolvedKey) {
      return NextResponse.json(
        { success: false, error: "No Gemini Client API Key configured.", provider, model },
        { status: 400 }
      );
    }
    // Gemini OpenAI compat endpoint
    endpoint = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;
    headers["Authorization"] = `Bearer ${resolvedKey}`;
  } else {
    // OpenRouter
    // Load OpenRouter key from DB
    try {
      const { data } = await supabase
        .from("agent_settings")
        .select("value")
        .eq("key", "openrouter_client_api_key")
        .single();
      if (data?.value) {
        resolvedKey = data.value.trim();
      }
    } catch {}

    if (!resolvedKey) {
      resolvedKey = process.env.OPENROUTER_API_KEY || "";
    }

    if (!resolvedKey) {
      return NextResponse.json(
        { success: false, error: "No OpenRouter Client API Key configured.", provider, model },
        { status: 400 }
      );
    }

    // Strip "openrouter/" prefix from model if present
    if (model.startsWith("openrouter/")) {
      model = model.slice("openrouter/".length);
    }

    endpoint = `https://openrouter.ai/api/v1/chat/completions`;
    headers["Authorization"] = `Bearer ${resolvedKey}`;
    headers["HTTP-Referer"] = "http://localhost:3000";
    headers["X-Title"] = "AgentComplete";
  }

  const start = Date.now();
  console.log(`[test-ai-model] → ${provider} | ${model} | ${endpoint}`);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with one word: ok" }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),
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
