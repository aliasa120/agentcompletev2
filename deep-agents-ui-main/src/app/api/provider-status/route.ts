import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

interface ProviderMeta {
  id: string;
  label: string;
  badgeColor: string;
  keySet: boolean;
  gateway: "openrouter-direct" | "gemini-direct";
  defaultModels: { value: string; label: string; badge: string }[];
}

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

  let openrouter_key = "";
  let customModelsByProvider: Record<string, string[]> = {};

  try {
    const { data: settings } = await supabase
      .from("agent_settings")
      .select("key, value");

    const settingsMap = new Map((settings || []).map(s => [s.key, s.value]));
    openrouter_key = settingsMap.get("openrouter_client_api_key")?.trim() || "";

    const rawCustom = settingsMap.get("custom_models_by_provider");
    if (rawCustom) {
      try { customModelsByProvider = JSON.parse(rawCustom); } catch {}
    }
  } catch {}

  const openrouter_keySet = !!(openrouter_key || process.env.OPENROUTER_API_KEY);
  const gemini_keySet = !!process.env.GEMINI_API_KEY;

  // OpenRouter models
  const orCustom = (customModelsByProvider["openrouter"] ?? []).map(v => ({
    value: v,
    label: v,
    badge: "Custom"
  }));
  const orHardcoded = [
    { value: "openrouter/tencent/hy3:free", label: "Hunyuan 3 Free", badge: "Free" },
    { value: "openrouter/google/gemini-2.5-flash", label: "Gemini 2.5 Flash", badge: "Cloud" },
    { value: "openrouter/google/gemini-2.5-pro", label: "Gemini 2.5 Pro", badge: "Cloud" },
  ];
  const orHardcodedValues = new Set(orHardcoded.map(m => m.value));
  const uniqueOrCustom = orCustom.filter(m => !orHardcodedValues.has(m.value));

  // Gemini models
  const geminiCustom = (customModelsByProvider["gemini"] ?? []).map(v => ({
    value: v,
    label: v,
    badge: "Custom"
  }));
  const geminiHardcoded = [
    { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", badge: "Direct" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", badge: "Direct" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", badge: "Direct" },
  ];
  const geminiHardcodedValues = new Set(geminiHardcoded.map(m => m.value));
  const uniqueGeminiCustom = geminiCustom.filter(m => !geminiHardcodedValues.has(m.value));

  const providers: ProviderMeta[] = [
    {
      id: "openrouter",
      label: "OpenRouter (Direct API)",
      badgeColor: "from-violet-500 to-purple-600",
      keySet: openrouter_keySet,
      gateway: "openrouter-direct",
      defaultModels: [...orHardcoded, ...uniqueOrCustom],
    },
    {
      id: "gemini",
      label: "Gemini (Direct API)",
      badgeColor: "from-blue-500 to-indigo-600",
      keySet: gemini_keySet,
      gateway: "gemini-direct",
      defaultModels: [...geminiHardcoded, ...uniqueGeminiCustom],
    }
  ];

  return NextResponse.json({ providers });
}
