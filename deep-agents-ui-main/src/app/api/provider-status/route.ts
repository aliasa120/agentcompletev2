import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

/**
 * GET /api/provider-status
 *
 * Returns which providers have their API key env var set.
 * Returns ONLY boolean values — key values are NEVER sent to the browser.
 * Also returns the registry of providers/models for UI rendering.
 *
 * This is the enterprise "key status" pattern:
 *   - Keys live in .env on the server
 *   - UI only knows "key is set / not set" (never the actual key)
 */

interface ProviderMeta {
  id: string;
  label: string;
  badgeColor: string;
  keySet: boolean;
  defaultModels: { value: string; label: string; badge: string }[];
}

// Mirror of provider_registry.py — keeps backend and frontend in sync.
// When you add a provider to provider_registry.py, add it here too.
const PROVIDER_REGISTRY: Record<string, {
  envKey: string;
  label: string;
  badgeColor: string;
  defaultModels: { value: string; label: string; badge: string }[];
}> = {
  vercel: {
    envKey: "AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway",
    badgeColor: "from-blue-500 to-indigo-600",
    defaultModels: [
      { value: "xiaomi/mimo-v2.5-pro",       label: "Mimo v2.5 Pro",      badge: "Recommended" },
      { value: "moonshotai/kimi-k2.5",        label: "Kimi K2.5",          badge: "Vision" },
      { value: "minimax/minimax-m2.7",         label: "MiniMax M2.7",       badge: "Fast" },
      { value: "openai/gpt-4o",               label: "GPT-4o",             badge: "OpenAI" },
      { value: "google/gemini-2.5-flash",     label: "Gemini 2.5 Flash",   badge: "Google" },
      { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5",  badge: "Anthropic" },
    ],
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    label: "OpenAI",
    badgeColor: "from-green-500 to-emerald-600",
    defaultModels: [
      { value: "gpt-4.1",     label: "GPT-4.1",     badge: "Latest" },
      { value: "gpt-4o",      label: "GPT-4o",      badge: "Vision" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini", badge: "Fast" },
      { value: "o3",          label: "o3",          badge: "Reasoning" },
      { value: "o4-mini",     label: "o4-mini",     badge: "Reasoning" },
    ],
  },
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    badgeColor: "from-orange-500 to-amber-600",
    defaultModels: [
      { value: "claude-opus-4-5",   label: "Claude Opus 4.5",   badge: "Most Capable" },
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", badge: "Balanced" },
      { value: "claude-haiku-3-5",  label: "Claude Haiku 3.5",  badge: "Fast" },
    ],
  },
  google: {
    envKey: "GOOGLE_API_KEY",
    label: "Google Gemini",
    badgeColor: "from-blue-500 via-red-500 to-yellow-500",
    defaultModels: [
      { value: "gemini-2.5-pro",   label: "Gemini 2.5 Pro",   badge: "Latest" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", badge: "Fast" },
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash", badge: "Stable" },
    ],
  },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    badgeColor: "from-violet-500 to-purple-600",
    defaultModels: [
      { value: "google/gemini-2.5-flash",     label: "Gemini 2.5 Flash",  badge: "Google" },
      { value: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick",  badge: "Meta" },
      { value: "deepseek/deepseek-r2",         label: "DeepSeek R2",       badge: "Reasoning" },
      { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", badge: "Anthropic" },
      { value: "openai/gpt-4o",               label: "GPT-4o",            badge: "OpenAI" },
      { value: "mistralai/mistral-large",     label: "Mistral Large",     badge: "Mistral" },
    ],
  },
  litellm: {
    envKey: "LITELLM_API_KEY",
    label: "LiteLLM Proxy",
    badgeColor: "from-purple-500 to-pink-600",
    defaultModels: [
      { value: "mimo-v2.5-pro",       label: "Mimo v2.5 Pro", badge: "LiteLLM" },
      { value: "openai/gpt-oss-120b", label: "GPT OSS 120B",  badge: "LiteLLM" },
    ],
  },
  groq: {
    envKey: "GROQ_API_KEY",
    label: "Groq",
    badgeColor: "from-rose-500 to-red-600",
    defaultModels: [
      { value: "llama-3.3-70b-versatile",        label: "Llama 3.3 70B",   badge: "Fast" },
      { value: "llama-3.1-8b-instant",           label: "Llama 3.1 8B",    badge: "Ultra-Fast" },
      { value: "gemma2-9b-it",                   label: "Gemma 2 9B",      badge: "Google" },
      { value: "deepseek-r1-distill-llama-70b",  label: "DeepSeek R1 70B", badge: "Reasoning" },
    ],
  },
  together: {
    envKey: "TOGETHER_API_KEY",
    label: "Together AI",
    badgeColor: "from-teal-500 to-cyan-600",
    defaultModels: [
      { value: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo", badge: "Fast" },
      { value: "deepseek-ai/DeepSeek-R1",                 label: "DeepSeek R1",          badge: "Reasoning" },
      { value: "Qwen/Qwen2.5-72B-Instruct-Turbo",         label: "Qwen 2.5 72B",         badge: "Qwen" },
      { value: "mistralai/Mistral-7B-Instruct-v0.3",      label: "Mistral 7B",           badge: "Efficient" },
    ],
  },
  nvidia: {
    // NVIDIA NIM — OpenAI-compatible endpoint: https://integrate.api.nvidia.com/v1
    // NIM sometimes emits empty-choices SSE chunks (filter with: if not chunk.choices: continue)
    envKey: "NVIDIA_API_KEY",
    label: "NVIDIA NIM",
    badgeColor: "from-green-600 to-lime-500",
    defaultModels: [
      { value: "minimaxai/minimax-m2.7",         label: "MiniMax M2.7",      badge: "Recommended" },
      { value: "stepfun-ai/step-3.7-flash",     label: "Step 3.7 Flash",    badge: "Fast" },
      { value: "openai/gpt-oss-120b",            label: "GPT OSS 120B",      badge: "Large" },
      { value: "deepseek-ai/deepseek-v4-flash",  label: "DeepSeek V4 Flash", badge: "Reasoning" },
    ],
  },
  mimo: {
    // Xiaomi MiMo — OpenAI-compatible endpoint: https://api.xiaomimimo.com/v1
    // Docs: https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api
    envKey: "MIMO_API_KEY",
    label: "Xiaomi MiMo",
    badgeColor: "from-orange-400 to-red-500",
    defaultModels: [
      { value: "mimo-v2.5-pro", label: "MiMo V2.5 Pro", badge: "Flagship" },
      { value: "mimo-v2.5",     label: "MiMo V2.5",     badge: "Fast" },
    ],
  },
  novita: {
    // Novita AI — OpenAI-compatible endpoint: https://api.novita.ai/openai/v1
    // Docs: https://novita.ai/docs
    envKey: "NOVITA_API_KEY",
    label: "Novita AI",
    badgeColor: "from-cyan-500 to-blue-600",
    defaultModels: [
      { value: "deepseek/deepseek-v4-flash",         label: "DeepSeek V4 Flash",  badge: "Recommended" },
      { value: "deepseek/deepseek-r2",               label: "DeepSeek R2",         badge: "Reasoning" },
      { value: "meta-llama/llama-4-maverick",        label: "Llama 4 Maverick",    badge: "Meta" },
      { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B",       badge: "Fast" },
      { value: "qwen/qwen3-235b-a22b",               label: "Qwen3 235B",          badge: "Large" },
      { value: "google/gemma-3-27b-it",              label: "Gemma 3 27B",         badge: "Google" },
    ],
  },
};

export async function GET() {
  let custom_models: Record<string, string[]> = {};
  try {
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("key", "custom_models_by_provider")
      .single();
    if (data?.value) {
      custom_models = JSON.parse(data.value);
    }
  } catch { /* no saved custom models yet */ }

  const providers: ProviderMeta[] = Object.entries(PROVIDER_REGISTRY).map(
    ([id, cfg]) => {
      const custom = custom_models[id] ?? [];
      const customModelsFormatted = custom.map(v => ({
        value: v,
        label: v,
        badge: "Custom",
      }));
      return {
        id,
        label: cfg.label,
        badgeColor: cfg.badgeColor,
        // Only boolean — NEVER send the actual key value
        keySet: Boolean(process.env[cfg.envKey]),
        defaultModels: [...cfg.defaultModels, ...customModelsFormatted],
      };
    }
  );

  return NextResponse.json({ providers });
}
