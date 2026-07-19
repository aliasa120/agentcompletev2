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

import fs from "fs";
import path from "path";

// GET /api/skills — list all skills (merged with local filesystem)
export async function GET() {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 1. Fetch skills from database
    const { data: dbSkills, error: dbError } = await supabase
      .from("skills_library")
      .select("*")
      .order("created_at", { ascending: true });

    if (dbError) {
      console.error("[api/skills] Supabase query error:", dbError);
    }

    // Filter out archived skills from UI presentation
    const skillsList = dbSkills ? dbSkills.filter(s => s.state !== "archived") : [];

    // 2. Read local filesystem skills (relative to process.cwd(), which is deep-agents-ui-main)
    const skillsDir = path.resolve(process.cwd(), "../research_agent/skills");

    if (fs.existsSync(skillsDir)) {
      const folders = fs.readdirSync(skillsDir);
      for (const folder of folders) {
        const folderPath = path.join(skillsDir, folder);
        if (fs.statSync(folderPath).isDirectory()) {
          const skillMdPath = path.join(folderPath, "SKILL.md");
          if (fs.existsSync(skillMdPath)) {
            const skillKey = folder;
            const content = fs.readFileSync(skillMdPath, "utf-8");

            // Check if skill already exists in the raw database list (including archived)
            // so we don't re-seed deleted/archived builtins
            const existsInDb = dbSkills && dbSkills.some((s) => s.skill_key === skillKey);

            if (!existsInDb) {
              const label = skillKey
                .split(/[-_]+/)
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" ");
              const description = `Built-in skill from ${skillKey} folder.`;

              // Try to auto-seed into Supabase so it has a real DB ID for UI actions
              if (dbSkills) {
                try {
                  const { data: insertedData, error: insertError } = await supabase
                    .from("skills_library")
                    .insert({
                      user_id: user.id, skill_key: skillKey,
                      label,
                      description,
                      content,
                      source: "builtin",
                    })
                    .select()
                    .single();

                  if (!insertError && insertedData) {
                    skillsList.push(insertedData);
                    console.log(`[api/skills] Auto-seeded builtin skill: ${skillKey}`);
                    continue;
                  }
                } catch (err) {
                  console.error(`[api/skills] Auto-seed failed for ${skillKey}:`, err);
                }
              }

              // Fallback to local representation if Supabase is offline/errored
              skillsList.push({
                id: skillKey, // folder name acts as fallback ID
                user_id: user.id, skill_key: skillKey,
                label,
                description,
                content,
                source: "builtin",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    return NextResponse.json({ skills: skillsList });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown", skills: [] });
  }
}

// POST /api/skills — create skill
export async function POST(req: Request) {
  const cookieStore = await cookies();
  const supabase = getSupabaseClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { skill_key, label, description, content, parent_skill_key } = body;
    if (!skill_key || !label || !content) {
      return NextResponse.json({ error: "skill_key, label, and content are required" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("skills_library")
      .insert({
        skill_key,
        label,
        description: description ?? "",
        content,
        source: "user",
        parent_skill_key: parent_skill_key || null
      })
      .select()
      .single();
    if (error) throw error;

    // Trigger agent hot-reload to re-compile graph prompt with new skill
    triggerAgentReload();

    return NextResponse.json({ skill: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

