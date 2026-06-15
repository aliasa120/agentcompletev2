import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/skills — list all skills (merged with local filesystem)
export async function GET() {
  try {
    // 1. Fetch skills from database
    const { data: dbSkills, error: dbError } = await supabase
      .from("skills_library")
      .select("*")
      .order("created_at", { ascending: true });

    if (dbError) {
      console.error("[api/skills] Supabase query error:", dbError);
    }

    const skillsList = dbSkills ? [...dbSkills] : [];

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

            // Check if skill already exists in the loaded database list
            const existsInDb = skillsList.some((s) => s.skill_key === skillKey);

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
                      skill_key: skillKey,
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
                skill_key: skillKey,
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
  try {
    const body = await req.json();
    const { skill_key, label, description, content } = body;
    if (!skill_key || !label || !content) {
      return NextResponse.json({ error: "skill_key, label, and content are required" }, { status: 400 });
    }
    const { data, error } = await supabase
      .from("skills_library")
      .insert({ skill_key, label, description: description ?? "", content, source: "user" })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ skill: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

