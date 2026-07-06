import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import path from "path";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface PythonParseResult {
  schedule: any;
  nextRunAt: string | null;
}

function getNextRunFromPython(scheduleStr: string): PythonParseResult {
  try {
    const pythonCode = `
import json
import sys
# Make sure workspace root is in path
sys.path.insert(0, ".")
from research_agent.tools.cronjob import parse_schedule, compute_next_run
try:
    parsed = parse_schedule(${JSON.stringify(scheduleStr)})
    next_run = compute_next_run(parsed)
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

// GET /api/scheduled-tasks — list all scheduled tasks
export async function GET() {
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
      workdir
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

    // Call Python to get structured schedule and next run timestamp
    let parsedSchedule;
    let nextRunAt;
    try {
      const parsed = getNextRunFromPython(schedule);
      parsedSchedule = parsed.schedule;
      nextRunAt = parsed.nextRunAt;
    } catch (parseErr: any) {
      return NextResponse.json({ error: `Invalid schedule: ${parseErr.message}` }, { status: 400 });
    }

    const taskName = name || (prompt ? (prompt.length > 45 ? prompt.substring(0, 45) + "..." : prompt) : path.basename(script || "Cron Task"));

    const { data, error } = await supabase
      .from("agent_scheduled_tasks")
      .insert({
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
