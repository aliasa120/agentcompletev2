import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { triggerAgentReload } from "@/lib/agent-reloader";

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

// POST /api/skills/promote — Force promote PROVISIONAL skill to TRUSTED
export async function POST(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { skill_id } = await req.json();
    if (!skill_id) {
      return NextResponse.json({ error: "skill_id is required" }, { status: 400 });
    }

    // 1. Promote target skill
    const { data: skillData, error: skillErr } = await supabase
      .from("skills_library")
      .update({ trust_state: "trusted", is_active: true })
      .eq("skill_id", skill_id)
      .select()
      .single();

    if (skillErr) throw skillErr;

    // 2. If parent_skill_id exists, archive parent
    if (skillData.parent_skill_id) {
      await supabase
        .from("skills_library")
        .update({ is_active: false })
        .eq("skill_id", skillData.parent_skill_id);
    }

    triggerAgentReload();

    return NextResponse.json({ success: true, skill: skillData });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}
