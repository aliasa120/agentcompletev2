import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

interface ProviderMeta {
  id: string;
  label: string;
  badgeColor: string;
  keySet: boolean;
  gateway?: string;
  baseUrl?: string;
  defaultModels: { value: string; label: string; badge: string }[];
  isCustom?: boolean;
}

const BUILTIN_PROVIDERS_CONFIG = [
  {
    id: "openrouter",
    label: "OpenRouter AI Gateway",
    badgeColor: "from-violet-500 to-purple-600",
    keyName: "openrouter_client_api_key",
    envKey: "OPENROUTER_API_KEY",
    defaultModels: [
      { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", badge: "Vision" },
      { value: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet", badge: "Vision" },
      { value: "deepseek/deepseek-r1", label: "DeepSeek R1", badge: "Reasoning" },
      { value: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", badge: "Fast" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini (Direct API)",
    badgeColor: "from-blue-500 to-indigo-600",
    keyName: "gemini_client_api_key",
    envKey: "GEMINI_API_KEY",
    defaultModels: [
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", badge: "Vision" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", badge: "Vision" },
      { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash", badge: "Vision" },
    ],
  },
  {
    id: "grok",
    label: "xAI (Grok)",
    badgeColor: "from-zinc-700 to-neutral-900",
    keyName: "grok_client_api_key",
    envKey: "XAI_API_KEY",
    defaultModels: [
      { value: "grok-2-vision-1212", label: "Grok 2 Vision", badge: "Vision" },
      { value: "grok-2-latest", label: "Grok 2 Latest", badge: "Direct" },
      { value: "grok-beta", label: "Grok Beta", badge: "Direct" },
    ],
  },
  {
    id: "together",
    label: "Together AI (Meta Llama)",
    badgeColor: "from-blue-600 to-cyan-600",
    keyName: "together_client_api_key",
    envKey: "TOGETHER_API_KEY",
    defaultModels: [
      { value: "meta-llama/Llama-3.2-11B-Vision-Instruct", label: "Llama 3.2 11B Vision", badge: "Vision" },
      { value: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", label: "Llama 3.1 70B Turbo", badge: "Direct" },
      { value: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1", badge: "Reasoning" },
      { value: "Qwen/Qwen2.5-72B-Instruct-Turbo", label: "Qwen 2.5 72B Turbo", badge: "Direct" },
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras (Ultra-Fast)",
    badgeColor: "from-emerald-500 to-teal-600",
    keyName: "cerebras_client_api_key",
    envKey: "CEREBRAS_API_KEY",
    defaultModels: [
      { value: "llama3.1-70b", label: "Llama 3.1 70B (Fastest)", badge: "UltraFast" },
      { value: "llama3.1-8b", label: "Llama 3.1 8B", badge: "UltraFast" },
      { value: "llama-3.3-70b", label: "Llama 3.3 70B", badge: "UltraFast" },
    ],
  },
  {
    id: "groq",
    label: "Groq (LPU Inference)",
    badgeColor: "from-orange-500 to-amber-600",
    keyName: "groq_client_api_key",
    envKey: "GROQ_API_KEY",
    defaultModels: [
      { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile", badge: "Fast" },
      { value: "llama-3.2-11b-vision-preview", label: "Llama 3.2 11B Vision", badge: "Vision" },
      { value: "deepseek-r1-distill-llama-70b", label: "DeepSeek R1 Distill 70B", badge: "Reasoning" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek (Direct API)",
    badgeColor: "from-sky-500 to-blue-700",
    keyName: "deepseek_client_api_key",
    envKey: "DEEPSEEK_API_KEY",
    defaultModels: [
      { value: "deepseek-chat", label: "DeepSeek V3 (Chat)", badge: "Direct" },
      { value: "deepseek-reasoner", label: "DeepSeek R1 (Reasoner)", badge: "Reasoning" },
    ],
  },
  {
    id: "mistral",
    label: "Mistral AI",
    badgeColor: "from-amber-500 to-orange-700",
    keyName: "mistral_client_api_key",
    envKey: "MISTRAL_API_KEY",
    defaultModels: [
      { value: "mistral-large-latest", label: "Mistral Large", badge: "Direct" },
      { value: "pixtral-large-latest", label: "Pixtral Large", badge: "Vision" },
      { value: "codestral-latest", label: "Codestral", badge: "Code" },
    ],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    badgeColor: "from-rose-500 to-red-600",
    keyName: "fireworks_client_api_key",
    envKey: "FIREWORKS_API_KEY",
    defaultModels: [
      { value: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B", badge: "Direct" },
      { value: "accounts/fireworks/models/llama-v3p2-11b-vision-instruct", label: "Llama 3.2 11B Vision", badge: "Vision" },
      { value: "accounts/fireworks/models/deepseek-r1", label: "DeepSeek R1", badge: "Reasoning" },
    ],
  },
  {
    id: "ollama",
    label: "Ollama (Self-Hosted)",
    badgeColor: "from-slate-600 to-zinc-800",
    keyName: "ollama_client_api_key",
    envKey: "OLLAMA_API_KEY",
    defaultModels: [
      { value: "llama3.2-vision:latest", label: "Llama 3.2 Vision (Local)", badge: "LocalVision" },
      { value: "qwen2.5:latest", label: "Qwen 2.5 (Local)", badge: "Local" },
      { value: "deepseek-r1:latest", label: "DeepSeek R1 (Local)", badge: "Local" },
    ],
  },
];

export async function GET() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
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

  let settingsMap = new Map<string, string>();
  let customModelsByProvider: Record<string, string[]> = {};
  let customAiProviders: any[] = [];

  try {
    const { data: settings } = await supabase
      .from("agent_settings")
      .select("key, value");

    settingsMap = new Map((settings || []).map(s => [s.key, s.value]));

    const rawCustom = settingsMap.get("custom_models_by_provider");
    if (rawCustom) {
      try { customModelsByProvider = JSON.parse(rawCustom); } catch {}
    }

    const rawCustomProviders = settingsMap.get("custom_ai_providers");
    if (rawCustomProviders) {
      try { customAiProviders = JSON.parse(rawCustomProviders); } catch {}
    }
  } catch {}

  const providers: ProviderMeta[] = [];

  // 1. Process 10 Built-in Providers
  for (const p of BUILTIN_PROVIDERS_CONFIG) {
    const dbKey = settingsMap.get(p.keyName)?.trim() || "";
    const envVal = process.env[p.envKey] || "";
    const keySet = p.id === "ollama" ? true : !!(dbKey || envVal);

    const customModels = (customModelsByProvider[p.id] ?? []).map(v => ({
      value: v,
      label: v,
      badge: "Custom",
    }));

    const hardcodedValues = new Set(p.defaultModels.map(m => m.value));
    const uniqueCustom = customModels.filter(m => !hardcodedValues.has(m.value));

    providers.push({
      id: p.id,
      label: p.label,
      badgeColor: p.badgeColor,
      keySet,
      defaultModels: [...p.defaultModels, ...uniqueCustom],
    });
  }

  // 2. Process Custom AI Providers added by the user
  if (Array.isArray(customAiProviders)) {
    for (const cp of customAiProviders) {
      if (!cp || !cp.id) continue;
      const customModels = (customModelsByProvider[cp.id] ?? (cp.models || [])).map((v: string) => ({
        value: v,
        label: v,
        badge: "Custom",
      }));

      providers.push({
        id: cp.id,
        label: cp.label || cp.id,
        badgeColor: cp.badgeColor || "from-teal-600 to-cyan-700",
        keySet: !!(cp.api_key || cp.apiKey),
        baseUrl: cp.base_url || cp.baseUrl,
        defaultModels: customModels.length > 0 ? customModels : [
          { value: `${cp.id}/default-model`, label: "Default Model", badge: "Custom" }
        ],
        isCustom: true,
      });
    }
  }

  return NextResponse.json({ providers });
}
