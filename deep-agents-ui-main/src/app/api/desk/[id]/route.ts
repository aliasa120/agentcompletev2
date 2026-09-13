/**
 * /api/desk/[id] — single Desk task card.
 *
 * GET    → fetch one card
 * PATCH  → { status? } — e.g. reset a failed card to pending for retry
 * DELETE → reject the task: delete its files from the origin thread workspace,
 *          then delete the card. The task "vanishes".
 *
 * File deletion mirrors the agent's layout (output/threads/<thread_id>/…) with
 * strict path containment via resolveThreadFilePath.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import fs from "fs";
import path from "path";
import { getSessionUser } from "@/lib/api-auth";
import { resolveThreadFilePath, THREADS_ROOT, assertThreadOwnership } from "@/lib/thread-files";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

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
          } catch {
            /* read-only cookie store in route handlers */
          }
        },
      },
    }
  );
}

function deleteThreadFile(threadId: string, relativePath: string): boolean {
  const resolved = resolveThreadFilePath(threadId, relativePath);
  if (!resolved) return false;
  try {
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { force: true });
      // Prune now-empty parent dirs inside the thread workspace.
      let dir = path.dirname(resolved);
      while (dir.startsWith(THREADS_ROOT + path.sep) && dir !== THREADS_ROOT) {
        try {
          const entries = fs.readdirSync(dir);
          if (entries.length > 0) break;
          fs.rmdirSync(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);

    const { data, error } = await supabase
      .from("desk_tasks")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json({ task: data });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await req.json();
    if (body?.status !== "pending") {
      return NextResponse.json({ error: "Only failed tasks can be reset to pending" }, { status: 400 });
    }

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);
    const { data: current, error: currentError } = await supabase
      .from("desk_tasks")
      .select("id,status,execution_id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (currentError) throw currentError;
    if (!current) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (current.status !== "failed") {
      return NextResponse.json({ error: "Only failed tasks can be reset" }, { status: 409 });
    }

    if (!current.execution_id) {
      return NextResponse.json({ error: "Failed task has no execution claim" }, { status: 409 });
    }
    const { data, error } = await supabase.rpc("transition_desk_task_execution", {
      p_task_id: id,
      p_user_id: user.id,
      p_execution_id: current.execution_id,
      p_expected_status: "failed",
      p_status: "pending",
      p_result: null,
      p_error: null,
      p_executed_at: null,
      p_run_id: null,
    });

    if (error) throw error;
    const task = Array.isArray(data) ? data[0] : data;
    if (!task) return NextResponse.json({ error: "Task state changed" }, { status: 409 });
    return NextResponse.json({ task });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);

    const { data: task, error } = await supabase
      .from("desk_tasks")
      .select("id, thread_id, files, status")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    if (task.status === "executing") {
      return NextResponse.json(
        { error: "Task is currently executing — wait for it to finish." },
        { status: 409 }
      );
    }

    const files: any[] = Array.isArray(task.files) ? task.files : [];
    if (files.length > 0) {
      if (!task.thread_id) {
        return NextResponse.json({ error: "Cannot verify ownership of task files" }, { status: 409 });
      }
      const ownership = await assertThreadOwnership(task.thread_id, user.id, true);
      if (!ownership.allowed) {
        return NextResponse.json({ error: "Thread ownership could not be verified" }, { status: 403 });
      }
      const invalidPath = files.some((f) => {
        const rel = typeof f === "string" ? f : f?.path;
        return !rel || !resolveThreadFilePath(task.thread_id, String(rel));
      });
      if (invalidPath) {
        return NextResponse.json({ error: "Task contains an invalid file path" }, { status: 400 });
      }
    }

    let deletedFiles = 0;
    for (const f of files) {
      const rel = typeof f === "string" ? f : f?.path;
      if (rel && deleteThreadFile(task.thread_id, String(rel))) {
        deletedFiles++;
      }
    }

    // 2. The task vanishes.
    const { error: delError } = await supabase
      .from("desk_tasks")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    if (delError) throw delError;

    return NextResponse.json({ success: true, deleted_files: deletedFiles });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
