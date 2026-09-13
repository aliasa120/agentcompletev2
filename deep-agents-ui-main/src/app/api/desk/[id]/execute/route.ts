/**
 * /api/desk/[id]/execute — one-click execution of a Desk task card button.
 *
 * POST { button_id?: string, values?: Record<string,any> }
 *
 * Merges the user's edited field values into the button's saved tool args and
 * launches a background run on the ORIGIN thread whose single user message is
 * `[DESK_EXECUTE] {json}`. The master graph routes that run to the
 * desk_execute node (no LLM) which invokes the tool exactly as saved — the
 * click itself is the approval, so the mid-chat "ask" interrupt is skipped.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { Client } from "@langchain/langgraph-sdk";
import { getSessionUser } from "@/lib/api-auth";
import { assertThreadOwnership } from "@/lib/thread-files";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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

function getLangGraphUrl(): string {
  return (
    process.env.NEXT_PUBLIC_LANGGRAPH_API_URL ||
    process.env.LANGGRAPH_API_URL ||
    "http://localhost:2024"
  ).replace(/\/+$/, "");
}

function getLangGraphApiKey(): string {
  return (
    process.env.LANGCHAIN_API_KEY ||
    process.env.NEXT_PUBLIC_LANGSMITH_API_KEY ||
    ""
  );
}

function getLangGraphClient(): Client {
  const apiUrl = getLangGraphUrl();
  const isLocal =
    apiUrl.includes("localhost") || apiUrl.includes("127.0.0.1");
  const apiKey = !isLocal ? getLangGraphApiKey() : "";
  return new Client({
    apiUrl,
    apiKey: apiKey || undefined,
    defaultHeaders: apiKey ? { "X-Api-Key": apiKey } : {},
  });
}

async function resolveAssistantId(client: Client): Promise<string> {
  const configured =
    process.env.NEXT_PUBLIC_ASSISTANT_ID || "research";
  const isUUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      configured
    );
  if (isUUID) return configured;
  try {
    const assistants = await client.assistants.search({
      graphId: configured,
      limit: 100,
    });
    const defaultAssistant = assistants.find(
      (a: any) => a.metadata?.["created_by"] === "system"
    );
    if (defaultAssistant) return defaultAssistant.assistant_id;
    if (assistants.length > 0) return assistants[0].assistant_id;
  } catch {
    /* fall through to the configured id */
  }
  return configured;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let taskId = "";
  let executionId = "";
  try {
    const { id } = await params;
    taskId = id;
    const body = await req.json().catch(() => null);
    if (!isPlainObject(body) || typeof body.button_id !== "string" || !isPlainObject(body.values ?? {})) {
      return NextResponse.json({ error: "button_id and a values object are required" }, { status: 400 });
    }
    const values = (body.values ?? {}) as Record<string, unknown>;
    const buttonId = body.button_id;

    const cookieStore = await cookies();
    const supabase = getSupabaseClient(cookieStore);

    const { data: task, error } = await supabase
      .from("desk_tasks")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    if (task.status === "executing") {
      return NextResponse.json(
        { error: "Task is already executing" },
        { status: 409 }
      );
    }
    if (task.status !== "pending" && task.status !== "failed") {
      return NextResponse.json(
        { error: `Task is '${task.status}' and cannot be executed again` },
        { status: 409 }
      );
    }

    const buttons: any[] = Array.isArray(task.buttons) ? task.buttons : [];
    const executeButtons = buttons.filter(
      (b) => (b?.kind ?? "execute") === "execute" && b?.tool_name
    );
    if (executeButtons.length === 0) {
      return NextResponse.json(
        { error: "This card has no executable button (missing tool schema)" },
        { status: 400 }
      );
    }

    const button = executeButtons.find((candidate) => candidate.id === buttonId);
    if (!button) {
      return NextResponse.json({ error: "Execute button not found" }, { status: 400 });
    }
    if (!task.agent_id) {
      return NextResponse.json({ error: "Task has no originating agent" }, { status: 400 });
    }
    const fields: any[] = Array.isArray(task.fields) ? task.fields : [];
    const fieldNames = new Set(fields.filter((field) => field?.name).map((field) => String(field.name)));
    const unknownField = Object.keys(values).find((name) => !fieldNames.has(name));
    if (unknownField) {
      return NextResponse.json({ error: `Unknown field: ${unknownField}` }, { status: 400 });
    }
    const readonlyField = fields.find((field) => field?.type === "readonly" && Object.hasOwn(values, String(field.name)));
    if (readonlyField) {
      return NextResponse.json({ error: `Field "${readonlyField.label || readonlyField.name}" is readonly` }, { status: 400 });
    }

    // Validate required fields.
    for (const f of fields) {
      if (!f?.required || (f?.type ?? "text") === "readonly") continue;
      const v = values[f.name];
      if (v === undefined ? !String(f.value ?? "").trim() : !String(v ?? "").trim()) {
        return NextResponse.json(
          { error: `Field "${f.label || f.name}" is required` },
          { status: 400 }
        );
      }
    }

    const args: Record<string, unknown> = isPlainObject(button.args) ? { ...button.args } : {};
    for (const f of fields) {
      if (!f?.name || f.type === "readonly") continue;
      const argKey = f.arg_key || f.name;
      if (!Object.hasOwn(values, f.name)) continue;
      let v: unknown = values[f.name];
      if ((f.type ?? "text") === "number" && v !== "" && v !== null) {
        const n = Number(v);
        if (Number.isNaN(n)) {
          return NextResponse.json({ error: `Field "${f.label || f.name}" must be a number` }, { status: 400 });
        }
        v = n;
      }
      if (f.type === "select" && Array.isArray(f.options) && !f.options.includes(v)) {
        return NextResponse.json({ error: `Field "${f.label || f.name}" has an invalid option` }, { status: 400 });
      }
      args[argKey] = v;
    }

    executionId = crypto.randomUUID();
    const executionPayload = {
      button_id: buttonId,
      tool_name: String(button.tool_name),
      tool_type: button.tool_type === "builtin" ? "builtin" : "mcp",
      agent_id: String(task.agent_id),
      arguments: args,
    };
    const { data: claimedRows, error: claimError } = await supabase.rpc("claim_desk_task_execution", {
      p_task_id: id,
      p_execution_id: executionId,
      p_execution_payload: executionPayload,
    });
    if (claimError) throw claimError;
    const claimedTask = Array.isArray(claimedRows) ? claimedRows[0] : claimedRows;
    if (!claimedTask) {
      return NextResponse.json({ error: "Task is already executing or no longer executable" }, { status: 409 });
    }

    const client = getLangGraphClient();
    const assistantId = await resolveAssistantId(client);

    const threadId: string = task.thread_id || "";
    if (!threadId) {
      await supabase.rpc("transition_desk_task_execution", {
        p_task_id: id,
        p_user_id: user.id,
        p_execution_id: executionId,
        p_expected_status: "executing",
        p_status: "pending",
        p_result: null,
        p_error: "Desk task has no origin thread",
        p_executed_at: null,
        p_run_id: null,
      });
      return NextResponse.json({ error: "Desk task has no origin thread" }, { status: 400 });
    }
    const ownership = await assertThreadOwnership(threadId, user.id, true);
    if (!ownership.allowed) {
      await supabase.rpc("transition_desk_task_execution", {
        p_task_id: id,
        p_user_id: user.id,
        p_execution_id: executionId,
        p_expected_status: "executing",
        p_status: "pending",
        p_result: null,
        p_error: "Origin thread ownership could not be verified",
        p_executed_at: null,
        p_run_id: null,
      });
      return NextResponse.json({ error: "Origin thread ownership could not be verified" }, { status: 403 });
    }

    const marker = `[DESK_EXECUTE] ${JSON.stringify({
      task_id: id,
      execution_id: executionId,
    })}`;

    const messageId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const run = await client.runs.create(threadId, assistantId, {
      input: {
        messages: [
          {
            id: messageId,
            role: "user",
            content: marker,
          },
        ],
      },
      config: {
        configurable: {
          workflow_id: task.workflow_id ?? undefined,
          user_id: user.id,
        },
      },
    });

    const { data: runIdStored, error: runIdError } = await supabase.rpc("set_desk_task_run_id", {
      p_task_id: id,
      p_user_id: user.id,
      p_execution_id: executionId,
      p_run_id: run.run_id,
    });
    if (runIdError) throw runIdError;
    if (!runIdStored) throw new Error("Desk execution claim changed before run registration");

    return NextResponse.json({
      success: true,
      task_id: id,
      thread_id: threadId,
      run_id: run.run_id,
      tool_name: button.tool_name,
      executed_args: args,
    });
  } catch (e: unknown) {
    if (taskId && executionId) {
      try {
        const cookieStore = await cookies();
        const supabase = getSupabaseClient(cookieStore);
        await supabase.rpc("transition_desk_task_execution", {
          p_task_id: taskId,
          p_user_id: user.id,
          p_execution_id: executionId,
          p_expected_status: "executing",
          p_status: "pending",
          p_result: null,
          p_error: e instanceof Error ? e.message : "Execution failed to start",
          p_executed_at: null,
          p_run_id: null,
        });
      } catch {
        /* best-effort reset */
      }
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
