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

import { execSync } from "child_process";
import path from "path";



interface PythonParseResult {
  schedule: any;
  nextRunAt: string | null;
}

function getNextRunFromPython(scheduleStr: string, timezone?: string | null): PythonParseResult {
  try {
    const pythonCode = `
import json
import sys
# Make sure workspace root is in path
sys.path.insert(0, ".")
from research_agent.tools.cronjob import parse_schedule, compute_next_run
try:
    parsed = parse_schedule(${JSON.stringify(scheduleStr)}, tz=${timezone ? JSON.stringify(timezone) : "None"})
    next_run = compute_next_run(parsed, tz=${timezone ? JSON.stringify(timezone) : "None"})
    print(json.dumps({"success": True, "schedule": parsed, "next_run_at": next_run}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const rootDir = path.resolve(process.cwd(), "..");
    const out = execSync("python -c " + JSON.stringify(pythonCode), { cwd: rootDir, encoding: "utf-8" });
    const res = JSON.parse(out.trim());
    if (res.success) {
      return { schedule: res.schedule, nextRunAt: res.next_run_at };
    } else {
      throw new Error(res.error);
    }
  } catch (err: any) {
    console.error("Failed to parse schedule using Python:", err);
    throw err;
  }
}

async function getUserTimezone(supabase: any, userId: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("agent_settings")
      .select("value")
      .eq("user_id", userId)
      .eq("key", "timezone")
      .maybeSingle();
    if (data?.value) return data.value;
  } catch (err) {
    console.error("Failed to load user timezone preference:", err);
  }
  return null;
}

// GET /api/scheduled-tasks — list all scheduled tasks
export async function GET() {

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  try {
    const { data: tasks, error } = await supabase
      .from("agent_scheduled_tasks")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ tasks: tasks ?? [] });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// POST /api/scheduled-tasks — create a new scheduled task
export async function POST(req: Request) {

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

  try {
    const body = await req.json();
    const {
      name,
      prompt,
      schedule,
      no_agent,
      script,
      context_from,
      repeat_times,
      deliver,
      skills,
      model,
      provider,
      base_url,
      enabled_toolsets,
      workdir,
      timezone,
      mount_chat,
      context_summary,
      origin
    } = body;

    if (!schedule) {
      return NextResponse.json({ error: "schedule is required" }, { status: 400 });
    }

    if (!no_agent && !prompt) {
      return NextResponse.json({ error: "prompt is required unless no_agent is true" }, { status: 400 });
    }

    if (no_agent && !script) {
      return NextResponse.json({ error: "script is required when no_agent is true" }, { status: 400 });
    }

    // Timezone: per-task override > user's saved scheduler preference
    const userTimezone = await getUserTimezone(supabase, user.id);
    const effectiveTimezone = timezone || userTimezone;

    // Call Python to get structured schedule and next run timestamp
    let parsedSchedule;
    let nextRunAt;
    try {
      const parsed = getNextRunFromPython(schedule, effectiveTimezone);
      parsedSchedule = parsed.schedule;
      nextRunAt = parsed.nextRunAt;
    } catch (parseErr: any) {
      return NextResponse.json({ error: `Invalid schedule: ${parseErr.message}` }, { status: 400 });
    }

    // A one-shot whose resolved time is already in the past would never fire
    if (parsedSchedule?.kind === "once" && !nextRunAt) {
      return NextResponse.json(
        { error: `Schedule "${schedule}" resolves to a time in the past. Pick a future time.` },
        { status: 400 }
      );
    }

    const taskName = name || (prompt ? (prompt.length > 45 ? prompt.substring(0, 45) + "..." : prompt) : path.basename(script || "Cron Task"));

    const { data, error } = await supabase
      .from("agent_scheduled_tasks")
      .insert({
        user_id: user.id,
        name: taskName,
        prompt: prompt ?? null,
        schedule: parsedSchedule,
        schedule_display: parsedSchedule.display || schedule,
        no_agent: !!no_agent,
        script: script ?? null,
        context_from: context_from ?? [],
        repeat_times: repeat_times ? parseInt(repeat_times, 10) : null,
        deliver: deliver ?? "local",
        skills: skills ?? [],
        model: model ?? null,
        provider: provider ?? null,
        base_url: base_url ?? null,
        enabled_toolsets: enabled_toolsets ?? [],
        workdir: workdir ?? null,
        timezone: effectiveTimezone ?? null,
        mount_chat: mount_chat ?? null,
        context_summary: context_summary ?? null,
        origin: origin ?? {},
        next_run_at: nextRunAt,
        state: "scheduled",
        enabled: true,
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ task: data });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
