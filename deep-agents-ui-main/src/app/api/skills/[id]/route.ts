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

type RouteParams = { params: Promise<{ id: string }> };

// PATCH /api/skills/[id]
export async function PATCH(req: Request, { params }: RouteParams) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const body = await req.json();
    const { data, error } = await supabase
      .from("skills_library")
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;

    // Trigger agent hot-reload to re-compile graph prompt with updated skill
    triggerAgentReload();

    return NextResponse.json({ skill: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

// DELETE /api/skills/[id]
export async function DELETE(_req: Request, { params }: RouteParams) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    // Check origin/source of the skill first
    const { data: targetSkill } = await supabase
      .from("skills_library")
      .select("origin, source")
      .eq("id", id)
      .single();

    if (targetSkill) {
      // Clean up all agent tool assignments for this skill
      if (targetSkill.skill_key) {
        await supabase
          .from("agent_tool_assignments")
          .delete()
          .eq("tool_key", targetSkill.skill_key)
          .eq("tool_type", "skill");
      }

      if (targetSkill.origin === "derived" || targetSkill.origin === "captured" || targetSkill.origin === "fixed" || targetSkill.source === "user") {
        // Hard delete from database for evolved/provisional/user skills
        const { error } = await supabase
          .from("skills_library")
          .delete()
          .eq("id", id);
        if (error) throw error;
      } else {
        // Soft-delete for imported builtin skills to prevent auto-reseeding
        const { error } = await supabase
          .from("skills_library")
          .update({ state: "archived", updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw error;
      }
    }

    // Trigger agent hot-reload to re-compile graph prompt without the deleted skill
    triggerAgentReload();

    return NextResponse.json({ success: true });

  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

