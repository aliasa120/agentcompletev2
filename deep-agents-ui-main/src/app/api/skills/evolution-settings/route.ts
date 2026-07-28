import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function getSupabaseClient(cookieStore: any) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
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

// GET /api/skills/evolution-settings
export async function GET() {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, error } = await supabase
      .from("skill_evolution_settings")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("[api/skills/evolution-settings] GET error:", error);
    }

    const defaultSettings = {
      user_id: user.id,
      analysis_provider: "openrouter",
      analysis_model: "google/gemini-2.0-flash",
      evolution_provider: "openrouter",
      evolution_model: "google/gemini-2.5-flash",
      dedup_threshold_percent: 85,
      trust_promotion_count: 2,
      skip_pure_chat: true,
      max_evolutions_per_day: 5,
      analysis_prompt_override: null,
      fix_prompt_override: null,
      derived_prompt_override: null,
      captured_prompt_override: null,
    };

    return NextResponse.json({ settings: data || defaultSettings });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// POST /api/skills/evolution-settings
export async function POST(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const row = {
      user_id: user.id,
      analysis_provider: body.analysis_provider ?? "openrouter",
      analysis_model: body.analysis_model ?? "google/gemini-2.0-flash",
      evolution_provider: body.evolution_provider ?? "openrouter",
      evolution_model: body.evolution_model ?? "google/gemini-2.5-flash",
      dedup_threshold_percent: Number(body.dedup_threshold_percent ?? 85),
      trust_promotion_count: Number(body.trust_promotion_count ?? 2),
      skip_pure_chat: Boolean(body.skip_pure_chat ?? true),
      max_evolutions_per_day: Number(body.max_evolutions_per_day ?? 5),
      analysis_prompt_override: body.analysis_prompt_override || null,
      fix_prompt_override: body.fix_prompt_override || null,
      derived_prompt_override: body.derived_prompt_override || null,
      captured_prompt_override: body.captured_prompt_override || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("skill_evolution_settings")
      .upsert(row, { onConflict: "user_id" })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ settings: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
