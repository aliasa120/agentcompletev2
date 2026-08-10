import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * GET /api/mentions — data for the composer's @-mention popover.
 *
 * Returns mentionable items in two categories:
 *   - skills: non-archived rows from skills_library
 *   - tools:  builtin tools assigned to a main agent (agent_tool_assignments,
 *             main agents = attach_all_skills agents or the ones named
 *             "Main Agent"/"my buddy"), plus agent commands are intentionally
 *             excluded (those live under the / popover).
 *
 * Item shape follows assistant-ui's Unstable_Mention:
 *   { id, type: "skill" | "tool", label, description, icon }
 * Selecting one inserts a directive chip (:skill[…]{name=id}) that the backend
 * parses in the load_memories preprocessing node.
 */

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
              cookieStore.set(name, value, options),
            );
          } catch {
            // read-only context — cookies can't be set here; safe to ignore
          }
        },
      },
    },
  );
}

export async function GET() {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [{ data: skills }, { data: assignments }] = await Promise.all([
      supabase
        .from("skills_library")
        .select("skill_key, label, description, state")
        .order("label", { ascending: true }),
      supabase
        .from("agent_tool_assignments")
        .select("tool_key, tool_label, agent_id, tool_type, enabled")
        .eq("tool_type", "builtin")
        .eq("enabled", true),
    ]);

    const skillItems = (skills ?? [])
      .filter((s: any) => s.state !== "archived" && s.skill_key)
      .map((s: any) => ({
        id: s.skill_key,
        type: "skill",
        label: s.label || s.skill_key,
        description: (s.description ?? "").slice(0, 120),
        icon: "BookOpen",
      }));

    // Tools belonging to any main agent (dedup by tool_key)
    const { data: mainAgents } = await supabase
      .from("agent_configs")
      .select("id, name")
      .in("name", ["Main Agent", "my buddy"]);
    const mainIds = new Set((mainAgents ?? []).map((a: any) => a.id));

    const seen = new Set<string>();
    const toolItems = (assignments ?? [])
      .filter((a: any) => mainIds.size === 0 || mainIds.has(a.agent_id))
      .filter((a: any) => a.tool_key && !seen.has(a.tool_key) && seen.add(a.tool_key))
      .map((a: any) => ({
        id: a.tool_key,
        type: "tool",
        label: a.tool_label || a.tool_key,
        description: "Agent tool — @-mention to explicitly request it",
        icon: "Wrench",
      }))
      .sort((a: any, b: any) => String(a.label).localeCompare(String(b.label)));

    return NextResponse.json({ skills: skillItems, tools: toolItems });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown", skills: [], tools: [] },
      { status: 500 },
    );
  }
}
