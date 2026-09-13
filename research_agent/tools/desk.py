"""add_to_desk — Deposit a task card on the user's Desk for one-click execution.

The Desk is the user's office desk: a place where the agent parks fully prepared
tasks instead of executing sensitive real-world actions (emails, publishing,
payments, sends) directly. Each card shows task details, editable argument
fields, and buttons bound to tool schemas — the user reviews, tweaks arguments
in the card, and executes with ONE click. No mid-chat approval interrupts.

Persisted in the Supabase table `desk_tasks`.
"""

import os
import json
import logging
from typing import Optional, List, Dict, Any

from langchain_core.tools import tool
from langchain_core.runnables import RunnableConfig

logger = logging.getLogger("add_to_desk")

FIELD_TYPES = {"text", "textarea", "number", "select", "readonly"}
BUTTON_KINDS = {"execute", "cancel"}
STATUSES = {"pending", "executing", "done", "failed"}


def _get_supabase_client():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not service_key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return create_client(url, service_key)


def _resolve_context(config: Optional[RunnableConfig]) -> Dict[str, Optional[str]]:
    """Resolve thread_id / workflow_id / agent_id / user_id from the run config."""
    ctx: Dict[str, Optional[str]] = {
        "thread_id": None,
        "workflow_id": None,
        "agent_id": None,
        "user_id": None,
    }
    if not config:
        return ctx
    configurable = config.get("configurable", {}) if hasattr(config, "get") else getattr(config, "configurable", {})
    ctx["thread_id"] = configurable.get("thread_id")
    ctx["workflow_id"] = configurable.get("workflow_id")
    ctx["agent_id"] = configurable.get("agent_id")
    ctx["user_id"] = configurable.get("user_id")
    return ctx


def _resolve_user_id(client, ctx: Dict[str, Optional[str]]) -> Optional[str]:
    """Tiered user_id resolution (config → agent_configs → workflows → ContextVar)."""
    user_id = ctx.get("user_id")
    if user_id:
        return str(user_id)

    agent_id = ctx.get("agent_id")
    if agent_id:
        try:
            resp = client.table("agent_configs").select("user_id").eq("id", str(agent_id)).execute()
            if resp.data:
                return str(resp.data[0].get("user_id"))
        except Exception as e:
            logger.warning(f"[add_to_desk] user_id lookup via agent_id failed: {e}")

    workflow_id = ctx.get("workflow_id")
    if workflow_id:
        try:
            resp = client.table("workflows").select("user_id").eq("id", str(workflow_id)).execute()
            if resp.data:
                return str(resp.data[0].get("user_id"))
        except Exception as e:
            logger.warning(f"[add_to_desk] user_id lookup via workflow_id failed: {e}")

    try:
        from research_agent.tools.provider_engine import active_user_id
        return active_user_id.get()
    except Exception:
        return None


def _normalize_files(files: Optional[List[Any]]) -> List[Dict[str, str]]:
    """Accept 'path' strings or {path, name, kind} dicts; store uniform dicts."""
    normalized: List[Dict[str, str]] = []
    for f in files or []:
        if isinstance(f, str):
            path = f.strip().replace("\\", "/").lstrip("/")
            if path:
                normalized.append({"path": path, "name": path.split("/")[-1], "kind": "file"})
        elif isinstance(f, dict):
            path = str(f.get("path", "")).strip().replace("\\", "/").lstrip("/")
            if path:
                normalized.append({
                    "path": path,
                    "name": str(f.get("name") or path.split("/")[-1]),
                    "kind": str(f.get("kind") or "file"),
                })
    return normalized


def _normalize_fields(fields: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Validate/normalize editable argument fields for the card UI."""
    normalized: List[Dict[str, Any]] = []
    for f in fields or []:
        if not isinstance(f, dict) or not f.get("name"):
            continue
        field_type = str(f.get("type", "text"))
        if field_type not in FIELD_TYPES:
            field_type = "text"
        field: Dict[str, Any] = {
            "name": str(f["name"]),
            "label": str(f.get("label") or f["name"]),
            "type": field_type,
            "value": f.get("value", ""),
            "required": bool(f.get("required", False)),
        }
        if f.get("arg_key"):
            field["arg_key"] = str(f["arg_key"])
        if f.get("help"):
            field["help"] = str(f["help"])
        if field_type == "select" and isinstance(f.get("options"), list):
            field["options"] = [str(o) for o in f["options"]]
        normalized.append(field)
    return normalized


def _normalize_buttons(buttons: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Validate/normalize action buttons. Execute buttons must carry a tool schema."""
    normalized: List[Dict[str, Any]] = []
    for b in buttons or []:
        if not isinstance(b, dict):
            continue
        kind = str(b.get("kind", "execute"))
        if kind not in BUTTON_KINDS:
            kind = "execute"
        button: Dict[str, Any] = {
            "id": str(b.get("id") or f"btn_{len(normalized) + 1}"),
            "label": str(b.get("label") or ("Cancel Task" if kind == "cancel" else "Execute")),
            "kind": kind,
        }
        if b.get("style"):
            button["style"] = str(b["style"])
        if b.get("description"):
            button["description"] = str(b["description"])
        if kind == "execute":
            tool_name = str(b.get("tool_name") or "").strip()
            if not tool_name:
                continue  # execute buttons without a tool are useless — drop
            args = b.get("args")
            args = args if isinstance(args, dict) else {}
            # Unwrap call_tool-style router bindings so the button is bound
            # DIRECTLY to the final tool (one-click execution invokes it as-is):
            #   {"tool_name": "call_tool", "args": {"tool_name": "gmail_send_email", "arguments": {...}}}
            #   → {"tool_name": "gmail_send_email", "args": {...}}
            inner_name = args.get("tool_name")
            if (
                tool_name == "call_tool"
                and isinstance(inner_name, str)
                and inner_name.strip()
                and inner_name.strip() != "call_tool"
            ):
                inner_args = args.get("arguments")
                if not isinstance(inner_args, dict):
                    inner_args = {k: v for k, v in args.items() if k not in ("tool_name", "arguments")}
                tool_name = inner_name.strip()
                args = inner_args
            button["tool_name"] = tool_name
            button["tool_type"] = str(b.get("tool_type") or "mcp")
            button["args"] = args
        normalized.append(button)
    return normalized


def _resolve_tool_key(tool_key: str, user_id: Optional[str]) -> Dict[str, Any]:
    """Resolve a tool key to its exact registered name.

    Order: builtin exact → MCP-cache exact → case-insensitive across both
    (agents frequently lowercase keys like GMAIL_SEND_EMAIL → gmail_send_email).

    Returns {"resolved": str|None, "tool_type": "builtin"|"mcp"|None,
             "candidates": [close-match keys]}.
    """
    from research_agent.tools.dynamic_router import TOOL_OBJECTS

    tool_key = str(tool_key or "").strip()
    result: Dict[str, Any] = {"resolved": None, "tool_type": None, "candidates": []}
    if not tool_key:
        return result

    if tool_key in TOOL_OBJECTS:
        return {"resolved": tool_key, "tool_type": "builtin", "candidates": []}

    candidates: List[str] = []
    ci_map: Dict[str, str] = {}
    try:
        client = _get_supabase_client()
        q = (
            client.table("mcp_connections")
            .select("connection_type,available_tools")
            .eq("status", "active")
        )
        if user_id:
            q = q.eq("user_id", str(user_id))
        resp = q.limit(60).execute()

        for conn in resp.data or []:
            for t in conn.get("available_tools") or []:
                key = t.get("tool_key") if isinstance(t, dict) else t
                if not key:
                    continue
                key = str(key)
                if key == tool_key:
                    return {"resolved": key, "tool_type": "mcp", "candidates": []}
                ci_map.setdefault(key.lower(), key)
                if (
                    tool_key.lower() in key.lower() or key.lower() in tool_key.lower()
                ) and key not in candidates:
                    candidates.append(key)

        ci_hit = ci_map.get(tool_key.lower())
        if ci_hit:
            if ci_hit in candidates:
                candidates.remove(ci_hit)
            return {"resolved": ci_hit, "tool_type": "mcp", "candidates": []}
    except Exception as e:
        logger.warning(f"[add_to_desk] tool key resolution lookup failed: {e}")

    for k in TOOL_OBJECTS:
        if k.lower() == tool_key.lower():
            return {"resolved": k, "tool_type": "builtin", "candidates": []}
        if tool_key.lower() in k.lower() and k not in candidates:
            candidates.append(k)

    # Fuzzy close-matches (e.g. gmail_send_mail → GMAIL_SEND_EMAIL)
    if not candidates:
        import difflib
        pool = list(ci_map.values()) if ci_map else []
        pool += [k for k in TOOL_OBJECTS if k not in pool]
        lower_to_key = {k.lower(): k for k in pool}
        fuzzy = difflib.get_close_matches(
            tool_key.lower(), list(lower_to_key.keys()), n=5, cutoff=0.6
        )
        candidates = [lower_to_key[f] for f in fuzzy]

    result["candidates"] = candidates[:10]
    return result


def resolve_tool_key_for_execution(tool_key: str, user_id: Optional[str] = None) -> Optional[str]:
    """Execute-time helper: exact or case-insensitive resolution of a tool key."""
    return _resolve_tool_key(tool_key, user_id).get("resolved")


def _load_tool_schema(tool_key: str, user_id: Optional[str]) -> Optional[Dict[str, Any]]:
    """Best-effort live load of a tool's schema: {properties, required, source}."""
    try:
        from research_agent.tools.dynamic_router import TOOL_OBJECTS
        if tool_key in TOOL_OBJECTS:
            t = TOOL_OBJECTS[tool_key]
            props = list((t.args or {}).keys())
            required = []
            schema = getattr(t, "args_schema", None)
            if schema is not None and hasattr(schema, "model_fields"):
                required = [n for n, f in schema.model_fields.items() if f.is_required()]
            return {"properties": props, "required": required, "source": "builtin"}
    except Exception as e:
        logger.debug(f"[add_to_desk] builtin schema load failed for '{tool_key}': {e}")

    try:
        from research_agent.tools.provider_engine import load_mcp_tool_by_key
        from research_agent.tools.mcp_loader import run_sync
        tools = run_sync(load_mcp_tool_by_key(tool_key, user_id))
        if tools:
            t = tools[0]
            props = list((t.args or {}).keys())
            required = []
            schema = getattr(t, "args_schema", None)
            if schema is not None and hasattr(schema, "model_fields"):
                required = [n for n, f in schema.model_fields.items() if f.is_required()]
            return {"properties": props, "required": required, "source": "mcp"}
    except Exception as e:
        logger.debug(f"[add_to_desk] MCP schema load failed for '{tool_key}': {e}")
    return None


def _validate_execute_buttons(
    buttons: List[Dict[str, Any]],
    user_id: Optional[str],
    fields: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Validate/repair every execute button's tool binding BEFORE the card is saved.

    - Resolves the tool key (case-insensitive auto-correct, e.g. gmail_send_email
      → GMAIL_SEND_EMAIL) and rewrites the button.
    - Errors on unknown tools (with close-match candidates) so the agent can fix
      the card immediately instead of the user hitting a dead button later.
    - Warns on args that don't exist in the tool's real schema and includes the
      schema so the agent can self-correct.
    """
    warnings: List[str] = []
    schemas: Dict[str, Dict[str, Any]] = {}
    field_names = [str(field.get("name")) for field in fields or [] if isinstance(field, dict) and field.get("name")]
    arg_keys = [str(field.get("arg_key") or field.get("name")) for field in fields or [] if isinstance(field, dict) and field.get("name")]
    if len(field_names) != len(set(field_names)) or len(arg_keys) != len(set(arg_keys)):
        return {"ok": False, "error": "Desk field names and argument mappings must be unique.", "candidates": []}
    button_ids = [str(button.get("id")) for button in buttons if button.get("id")]
    if len(button_ids) != len(set(button_ids)):
        return {"ok": False, "error": "Desk button IDs must be unique.", "candidates": []}
    for field in fields or []:
        if field.get("type") == "select" and not field.get("options"):
            return {"ok": False, "error": f"Select field '{field.get('name')}' requires options.", "candidates": []}
    for b in buttons:
        if b.get("kind") != "execute":
            continue
        res = _resolve_tool_key(b["tool_name"], user_id)
        if not res["resolved"]:
            return {
                "ok": False,
                "error": (
                    f"Tool '{b['tool_name']}' does not exist for this user, so the button "
                    f"would fail at click time. Do NOT guess tool names or arguments — call "
                    f"load_tools with the exact tool key first, then re-create the card "
                    f"using the exact key and the schema's argument names."
                ),
                "candidates": res["candidates"],
            }
        if res["resolved"] != b["tool_name"]:
            warnings.append(
                f"Button '{b['label']}': tool_name '{b['tool_name']}' auto-corrected to "
                f"'{res['resolved']}' (tool keys are case-sensitive)."
            )
            b["tool_name"] = res["resolved"]
        b["tool_type"] = res["tool_type"]

        schema = _load_tool_schema(res["resolved"], user_id)
        if not schema:
            continue
        schemas[res["resolved"]] = {
            "properties": sorted(schema["properties"]),
            "required": schema["required"],
        }
        props = set(schema["properties"])
        unknown = [a for a in b["args"] if a not in props]
        mapped_fields = set()
        for field in fields or []:
            if isinstance(field, dict) and field.get("name"):
                mapped_fields.add(str(field.get("arg_key") or field["name"]))
        if unknown:
            return {
                "ok": False,
                "error": f"Button '{b['label']}' has unknown args {unknown}. Valid args: {sorted(props)}.",
                "candidates": [],
            }
        missing = [r for r in schema["required"] if r not in b["args"] and r not in mapped_fields]
        if missing:
            return {
                "ok": False,
                "error": f"Button '{b['label']}' is missing required args {missing} for '{res['resolved']}'.",
                "candidates": [],
            }
    return {"ok": True, "warnings": warnings, "schemas": schemas}


def update_desk_task_status(
    task_id: str,
    user_id: str,
    execution_id: str,
    expected_status: str,
    status: str,
    result: Optional[str] = None,
    error: Optional[str] = None,
    executed_at: Optional[str] = None,
    run_id: Optional[str] = None,
) -> bool:
    if status not in STATUSES or not all((task_id, user_id, execution_id, expected_status)):
        return False
    try:
        client = _get_supabase_client()
        resp = client.rpc("transition_desk_task_execution", {
            "p_task_id": str(task_id),
            "p_user_id": str(user_id),
            "p_execution_id": str(execution_id),
            "p_expected_status": expected_status,
            "p_status": status,
            "p_result": result[:20000] if result is not None else None,
            "p_error": error[:8000] if error is not None else None,
            "p_executed_at": executed_at,
            "p_run_id": run_id,
        }).execute()
        return bool(resp.data)
    except Exception as e:
        logger.error(f"[add_to_desk] Failed to transition task {task_id}: {e}")
        return False


@tool(parse_docstring=True)
def add_to_desk(
    action: str,
    title: Optional[str] = None,
    summary: Optional[str] = None,
    user_prompt: Optional[str] = None,
    fields: Optional[List[Dict[str, Any]]] = None,
    buttons: Optional[List[Dict[str, Any]]] = None,
    files: Optional[List[Any]] = None,
    task_id: Optional[str] = None,
    status: Optional[str] = None,
    config: RunnableConfig = None,
) -> str:
    """Place or manage a task card on the user's Desk so they can review, edit arguments, and run it with ONE click.

    Use this INSTEAD of directly executing sensitive real-world actions (sending emails, publishing posts,
    messaging people, payments, deleting things) when the user asked for the task to be added to their desk,
    OR whenever the action has irreversible side effects the user should eyeball first. You still do ALL the
    preparation work yourself (research, write the email/post, generate the PDF, gather the recipient...);
    the card only hands the FINAL arguments to the user for a one-click send.

    ACTIONS:
      - create: deposit a new task card (title, summary, user_prompt, fields, buttons, files).
      - list:   list the user's desk tasks (optionally filter by status).
      - get:    fetch one task by task_id.
      - update: modify a still-pending card (title/summary/fields/buttons/files) by task_id.
      - complete: mark a task done yourself with a result message (only when you handled it without the Desk).

    CARD ANATOMY (what the user sees):
      1. Task details — title, your summary, and the user_prompt that initiated the task (audit trail).
      2. Editable fields — the card arguments. Each field: {"name": "<tool arg name>", "label": "Recipient",
         "type": "text|textarea|number|select|readonly", "value": "<prepared default>", "required": true,
         "options": ["a","b"] (select only), "help": "hint"}. The field's name MUST match the tool argument
         name it fills (or set "arg_key"). Use "readonly" fields to show prepared content the user shouldn't
         edit. Long bodies (email text, post captions) → "textarea".
      3. Buttons — one per action. Each execute button: {"id": "send", "label": "Send Email", "kind": "execute",
         "tool_name": "<FINAL tool name, e.g. gmail_send_email — NOT the 'call_tool' wrapper>", "tool_type": "builtin|mcp",
         "args": {<full argument dict with your prepared defaults>}, "style": "primary", "description": "..."}.
         When the user clicks it, that tool runs with the card's (possibly edited) arguments — exactly like you
         would call it. A "Reject Task" cancel button (kind "cancel", no tool schema) is ALWAYS added
         automatically: rejecting deletes the card and its files, so you usually don't need to add one.
      4. Files — paths (relative to this thread's workspace) of artifacts you produced for this task
         (e.g. "report.pdf"). They appear as attachments on the card and are deleted if the task is rejected.

    RULES:
      - Do the whole task first; only the final irreversible step goes on the Desk.
      - Every execute button needs tool_name + complete args. Bind the button DIRECTLY to the
        FINAL tool (e.g. "gmail_send_email", the same name you pass to call_tool) — never to the
        "call_tool" wrapper itself.
      - NEVER guess tool keys or argument names. For MCP tools run list_tools to get the exact
        (case-sensitive) key, then load_tools to read the real schema, and use the schema's exact
        argument names in fields and args. add_to_desk validates every button: unknown keys are
        rejected (with close-match suggestions), case mismatches are auto-corrected, and arg
        mismatches produce warnings with the validated schema so you can fix them via update.
      - Include the exact user request in user_prompt (how the task was initiated).
      - List every file you created for this task in files.

    Args:
        action: One of "create", "list", "get", "update", "complete".
        title: Short card headline, e.g. "Send sick-day email to boss".
        summary: What you prepared and how (shown on the card under the title).
        user_prompt: The original user message that initiated this task.
        fields: Editable card arguments; field "name" must match the tool arg it fills.
        buttons: Execute buttons, each with tool_name and full args dict.
        files: Paths of files you created for this task (relative to thread workspace).
        task_id: Task UUID (required for get/update/complete).
        status: Optional status filter for list ("pending", "done", ...).

    Returns:
        JSON confirmation with task_id for create, or task data for get/list.
    """
    try:
        action = (action or "").strip().lower()
        client = _get_supabase_client()
        ctx = _resolve_context(config)
        user_id = _resolve_user_id(client, ctx)
        if not user_id:
            return json.dumps({"error": "Could not resolve user_id from the run context."})

        if action == "create":
            if not title:
                return json.dumps({"error": "title is required for create."})
            if not ctx.get("agent_id"):
                return json.dumps({"error": "agent_id is required to create executable Desk tasks."})
            thread_id = ctx.get("thread_id") or ""

            norm_buttons = _normalize_buttons(buttons)
            execute_buttons = [b for b in norm_buttons if b["kind"] == "execute"]
            if not execute_buttons:
                return json.dumps({
                    "error": "At least one execute button with a tool_name and args is required.",
                    "hint": "Buttons look like: {\"label\": \"Send Email\", \"kind\": \"execute\", \"tool_name\": \"<tool>\", \"args\": {...}}",
                })

            norm_fields = _normalize_fields(fields)
            validation = _validate_execute_buttons(execute_buttons, user_id, norm_fields)
            if not validation["ok"]:
                err: Dict[str, Any] = {"error": validation["error"]}
                if validation.get("candidates"):
                    err["did_you_mean"] = validation["candidates"]
                return json.dumps(err)

            for execute_button in execute_buttons:
                from research_agent.tools.dynamic_router import get_enabled_tool_assignment
                authorization = get_enabled_tool_assignment(
                    str(ctx["agent_id"]), execute_button["tool_name"], str(user_id)
                )
                if not authorization.get("ok"):
                    return json.dumps({"error": authorization.get("error") or "Tool is not assigned to this agent."})

            row = {
                "user_id": str(user_id),
                "thread_id": str(thread_id),
                "workflow_id": ctx.get("workflow_id"),
                "agent_id": ctx.get("agent_id"),
                "title": str(title),
                "summary": str(summary or ""),
                "user_prompt": str(user_prompt or ""),
                "status": "pending",
                "fields": norm_fields,
                "buttons": norm_buttons,
                "files": _normalize_files(files),
            }
            resp = client.table("desk_tasks").insert(row).execute()
            created = (resp.data or [{}])[0]
            logger.info(f"[add_to_desk] Created task '{title}' ({created.get('id')}) for user {user_id}")
            response: Dict[str, Any] = {
                "success": True,
                "task_id": created.get("id"),
                "title": created.get("title"),
                "thread_id": thread_id,
                "buttons": [b.get("label") for b in execute_buttons],
                "message": (
                    "Task card placed on the user's Desk. Tell the user it is waiting there: "
                    "they can review details, edit the arguments, and run it with one click "
                    "(Settings → Desk). Rejecting the task deletes it along with its files."
                ),
            }
            if validation.get("warnings"):
                response["warnings"] = validation["warnings"]
            if validation.get("schemas"):
                response["validated_tool_schemas"] = validation["schemas"]
            return json.dumps(response)

        if action == "list":
            if not user_id:
                return json.dumps({"error": "Could not resolve user_id."})
            q = client.table("desk_tasks").select("id,title,status,created_at,thread_id").eq("user_id", str(user_id))
            if status:
                q = q.eq("status", status)
            resp = q.order("created_at", desc=True).limit(50).execute()
            return json.dumps({"tasks": resp.data or []})

        if action == "get":
            if not task_id:
                return json.dumps({"error": "task_id is required for get."})
            resp = (
                client.table("desk_tasks")
                .select("*")
                .eq("id", str(task_id))
                .eq("user_id", str(user_id))
                .maybe_single()
                .execute()
            )
            if not resp.data:
                return json.dumps({"error": f"Task {task_id} not found."})
            return json.dumps({"task": resp.data})

        if action == "update":
            if not task_id:
                return json.dumps({"error": "task_id is required for update."})
            updates: Dict[str, Any] = {}
            if title is not None:
                updates["title"] = str(title)
            if summary is not None:
                updates["summary"] = str(summary)
            if user_prompt is not None:
                updates["user_prompt"] = str(user_prompt)
            if fields is not None:
                updates["fields"] = _normalize_fields(fields)
            if buttons is not None:
                norm = _normalize_buttons(buttons)
                execute_buttons = [b for b in norm if b["kind"] == "execute"]
                if not execute_buttons:
                    return json.dumps({"error": "update requires at least one execute button with tool_name + args."})
                validation = _validate_execute_buttons(execute_buttons, user_id, _normalize_fields(fields))
                if not validation["ok"]:
                    err: Dict[str, Any] = {"error": validation["error"]}
                    if validation.get("candidates"):
                        err["did_you_mean"] = validation["candidates"]
                    return json.dumps(err)
                updates["buttons"] = norm
            if files is not None:
                updates["files"] = _normalize_files(files)
            if not updates:
                return json.dumps({"error": "Nothing to update — provide fields/buttons/files/title/summary."})
            resp = (
                client.table("desk_tasks")
                .update(updates)
                .eq("id", str(task_id))
                .eq("user_id", str(user_id))
                .eq("status", "pending")
                .execute()
            )
            if not resp.data:
                return json.dumps({"error": "Task not found or not in 'pending' status."})
            return json.dumps({"success": True, "task_id": task_id, "updated": list(updates.keys())})

        if action == "complete":
            if not task_id:
                return json.dumps({"error": "task_id is required for complete."})
            resp = (
                client.table("desk_tasks")
                .update({
                    "status": "done",
                    "result": str(summary or "Completed by agent.")[:20000],
                    "executed_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
                })
                .eq("id", str(task_id))
                .eq("user_id", str(user_id))
                .eq("status", "pending")
                .execute()
            )
            return json.dumps({"success": bool(resp.data), "task_id": task_id})

        return json.dumps({"error": f"Unknown action '{action}'. Use create|list|get|update|complete."})

    except Exception as e:
        logger.error(f"[add_to_desk] Error: {e}")
        return json.dumps({"error": f"add_to_desk failed: {e}"})
