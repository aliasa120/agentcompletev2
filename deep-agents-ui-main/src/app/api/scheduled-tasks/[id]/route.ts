import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import path from "path";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type RouteParams = { params: Promise<{ id: string }> };

interface PythonParseResult {
  schedule: any;
  nextRunAt: string | null;
}

function getNextRunFromPython(scheduleStr: string, lastRunAt?: string | null): PythonParseResult {
  try {
    const pythonCode = `
import json
import sys
sys.path.insert(0, ".")
from research_agent.tools.cronjob import parse_schedule, compute_next_run
try:
    parsed = parse_schedule(${JSON.stringify(scheduleStr)})
    next_run = compute_next_run(parsed, last_run_at=${lastRunAt ? JSON.stringify(lastRunAt) : "None"})
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

// GET /api/scheduled-tasks/[id] — fetch task details
export async function GET(_req: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const { data, error } = await supabase
      .from("agent_scheduled_tasks")
      .select("*")
      .eq("id", id)
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

// PATCH /api/scheduled-tasks/[id] — update task details
export async function PATCH(req: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const body = await req.json();
    
    // Check if task exists first
    const { data: existing, error: fetchError } = await supabase
      .from("agent_scheduled_tasks")
      .select("*")
      .eq("id", id)
      .single();
      
    if (fetchError || !existing) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const updates: any = { ...body, updated_at: new Date().toISOString() };

    // Handle schedule changes
    if (body.schedule && body.schedule !== existing.schedule_display) {
      try {
        const parsed = getNextRunFromPython(body.schedule, existing.last_run_at);
        updates.schedule = parsed.schedule;
        updates.schedule_display = parsed.schedule.display || body.schedule;
        if (updates.enabled !== false && updates.state !== "paused") {
          updates.next_run_at = parsed.nextRunAt;
        }
      } catch (parseErr: any) {
        return NextResponse.json({ error: `Invalid schedule: ${parseErr.message}` }, { status: 400 });
      }
    }

    // Handle resume action
    if (body.enabled === true && existing.enabled === false) {
      try {
        const parsed = getNextRunFromPython(existing.schedule_display, existing.last_run_at);
        updates.next_run_at = parsed.nextRunAt;
        updates.state = "scheduled";
      } catch {}
    }

    // Handle trigger now action
    if (body.trigger_now) {
      updates.next_run_at = new Date().toISOString();
      updates.state = "scheduled";
      updates.enabled = true;
      delete updates.trigger_now;
    }

    const { data: task, error } = await supabase
      .from("agent_scheduled_tasks")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ task, success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/scheduled-tasks/[id] — delete task
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const { error } = await supabase.from("agent_scheduled_tasks").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
