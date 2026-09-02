#!/usr/bin/env python3
"""
slack_server.py — Multi-tenant Slack Socket Mode manager for Deep Agents.
"""

import os
import sys
import time
import asyncio
import logging
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Setup Logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger("slack_server")

# Check required libraries
try:
    from slack_sdk.web.async_client import AsyncWebClient
    from slack_sdk.socket_mode.aiohttp import SocketModeClient
    from slack_sdk.socket_mode.response import SocketModeResponse
    from slack_sdk.socket_mode.request import SocketModeRequest
except ImportError:
    logger.error("slack-sdk is not installed. Run: uv pip install slack-sdk")
    sys.exit(1)

try:
    from supabase import create_client, Client, ClientOptions
except ImportError:
    logger.error("supabase is not installed. Run: uv pip install supabase")
    sys.exit(1)

try:
    from langgraph_sdk import get_client
except ImportError:
    logger.error("langgraph-sdk is not installed. Run: uv pip install langgraph-sdk")
    sys.exit(1)

# Agent feature helpers (command registry + TTS audio markers + task tracker)
try:
    from research_agent.commands import resolve_command, help_lines as cmd_help_lines
    from research_agent.tts import extract_audio_markers
    from research_agent.task_tracker import TaskTracker
except ImportError as ie:
    logger.warning(f"research_agent helpers not importable ({ie}); commands and voice replies disabled")
    resolve_command = None
    cmd_help_lines = lambda: []  # noqa: E731
    extract_audio_markers = lambda t: (None, False, None, t or "")  # noqa: E731
    TaskTracker = None

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get("SUPABASE_ANON_KEY", "").strip()
LANGGRAPH_API_URL = os.environ.get("LANGGRAPH_API_URL", "http://localhost:2024").strip()

if not SUPABASE_URL or not SUPABASE_KEY:
    logger.error("SUPABASE_URL and either SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY must be set in .env")
    sys.exit(1)

try:
    supabase_options = ClientOptions(
        storage_client_timeout=300,
        postgrest_client_timeout=300
    )
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=supabase_options)
    logger.info("Supabase client initialized successfully with 300s timeout options.")
except Exception as e:
    logger.error(f"Failed to initialize Supabase: {e}")
    sys.exit(1)

try:
    langgraph_client = get_client(url=LANGGRAPH_API_URL)
    logger.info(f"LangGraph client initialized targeting {LANGGRAPH_API_URL}")
except Exception as e:
    logger.error(f"Failed to initialize LangGraph client: {e}")
    sys.exit(1)

RESOLVED_ASSISTANT_ID = None


# ── Markdown Table to ASCII Renderer (same as Telegram bot) ──────────────────

def is_separator_line(line: str) -> bool:
    line_strip = line.strip()
    if not line_strip or "|" not in line_strip:
        return False
    allowed_chars = set("|-: \t")
    return set(line_strip).issubset(allowed_chars) and "-" in line_strip


def _render_ascii_table(header: str, data_lines: list[str]) -> str:
    import re
    def clean_cell(cell: str) -> str:
        c = re.sub(r"\*\*|__", "", cell)
        c = re.sub(r"\*|_", "", c)
        c = re.sub(r"`", "", c)
        c = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", c)
        return c.strip()

    def parse_row(row_str: str) -> list[str]:
        cells = row_str.split("|")
        stripped = row_str.strip()
        if stripped.startswith("|"):
            cells = cells[1:]
        if stripped.endswith("|") and len(cells) > 0:
            cells = cells[:-1]
        return [clean_cell(c) for c in cells]

    header_cells = parse_row(header)
    rows_cells = [parse_row(line) for line in data_lines]

    all_rows = [header_cells] + rows_cells
    num_cols = max(len(row) for row in all_rows) if all_rows else 0
    if num_cols == 0:
        return ""

    for row in all_rows:
        while len(row) < num_cols:
            row.append("")

    col_widths = [0] * num_cols
    for row in all_rows:
        for idx, cell in enumerate(row):
            col_widths[idx] = max(col_widths[idx], len(cell))

    formatted_lines = []
    header_line = " | ".join(cell.ljust(col_widths[idx]) for idx, cell in enumerate(header_cells))
    formatted_lines.append(header_line)

    sep_line = "-+-".join("-" * col_widths[idx] for idx in range(num_cols))
    formatted_lines.append(sep_line)

    for row in rows_cells:
        row_line = " | ".join(cell.ljust(col_widths[idx]) for idx, cell in enumerate(row))
        formatted_lines.append(row_line)

    return "```\n" + "\n".join(formatted_lines) + "\n```"


def format_markdown_tables(text: str) -> str:
    lines = text.split("\n")
    processed_lines = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        if is_separator_line(line) and i > 0:
            header = processed_lines.pop()
            data_lines = []
            j = i + 1
            while j < n:
                data_line = lines[j]
                if "|" in data_line and not is_separator_line(data_line):
                    data_lines.append(data_line)
                    j += 1
                else:
                    break
            formatted_table = _render_ascii_table(header, data_lines)
            processed_lines.append(formatted_table)
            i = j
            continue
        processed_lines.append(line)
        i += 1

    return "\n".join(processed_lines)


def convert_markdown_to_slack(text: str) -> str:
    import re
    
    # 1. Extract code blocks (```...```) to protect them
    code_blocks = []
    def save_code_block(match):
        code_blocks.append(match.group(1))
        return f"PLACEHOLDERCODEBLOCK{len(code_blocks)-1}"
    
    text = re.sub(r'```(.*?)```', save_code_block, text, flags=re.DOTALL)
    
    # Protect inline code (`...`)
    inline_codes = []
    def save_inline_code(match):
        inline_codes.append(match.group(1))
        return f"PLACEHOLDERINLINECODE{len(inline_codes)-1}"
    text = re.sub(r'`(.*?)`', save_inline_code, text)
    
    # 2. Format blockquotes and callouts line-by-line
    lines = text.split("\n")
    formatted_lines = []
    
    callout_map = {
        "[!info]": "ℹ️ *Info:*",
        "[!note]": "📝 *Note:*",
        "[!tip]": "💡 *Tip:*",
        "[!warning]": "⚠️ *Warning:*",
        "[!important]": "🚨 *Important:*",
        "[!caution]": "🛑 *Caution:*"
    }
    
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(">"):
            quote_line = stripped[1:].strip()
            # Check for callout tag
            for tag, replacement in callout_map.items():
                if quote_line.startswith(tag):
                    quote_line = quote_line.replace(tag, replacement, 1)
                    break
            formatted_lines.append(f"> {quote_line}")
        else:
            formatted_lines.append(line)
            
    text = "\n".join(formatted_lines)
    
    # 3. Format other markdown elements:
    # Bold
    text = re.sub(r'\*\*(.*?)\*\*', r'*\1*', text)
    text = re.sub(r'__(.*?)__', r'*\1*', text)
    # Italics
    text = re.sub(r'(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)', r'_\1_', text)
    text = re.sub(r'(?<!_)_(?!_)(.*?)(?<!_)_(?!_)', r'_\1_', text)
    # Links
    text = re.sub(r'\[(.*?)\]\((.*?)\)', r'<\2|\1>', text)
    
    # 4. Restore Protected Code Blocks
    for i, code_content in enumerate(code_blocks):
        text = text.replace(f"PLACEHOLDERCODEBLOCK{i}", f"```{code_content}```")
        
    for i, code_content in enumerate(inline_codes):
        text = text.replace(f"PLACEHOLDERINLINECODE{i}", f"`{code_content}`")
        
    return text


class SlackBotInstance:
    def __init__(self, conn_id: str, bot_token: str, app_token: str, user_id: str):
        self.conn_id = conn_id
        self.bot_token = bot_token
        self.app_token = app_token
        self.user_id = user_id
        self.web_client = AsyncWebClient(token=self.bot_token)
        self.socket_client = None
        self.active_sessions = {}  # channel_id -> {workflow_id, workflow_name, thread_id}
        self.voice_modes = {}      # channel_id -> "off" | "voice_only" | "all"
        self.is_running = False

    def get_voice_mode(self, channel_id: str) -> str:
        return self.voice_modes.get(channel_id, "voice_only")

    # ── Terminal command approval (human-in-the-loop) + run finishing ──────────

    async def _pending_interrupt(self, thread_id: str) -> dict | None:
        """Return the pending HITL interrupt payload (e.g. terminal approval), if any."""
        try:
            state = await langgraph_client.threads.get_state(thread_id)
        except Exception as e:
            logger.warning(f"Interrupt check get_state failed: {e}")
            return None
        values = state.get("values", {}) if isinstance(state, dict) else {}
        for intr in (values.get("__interrupt__") or []):
            v = intr.get("value") if isinstance(intr, dict) else None
            if isinstance(v, dict) and (v.get("action_requests") or v.get("actionRequests")):
                return v
        for task in (state.get("tasks") or []):
            for intr in (task.get("interrupts") or []):
                v = intr.get("value") if isinstance(intr, dict) else None
                if isinstance(v, dict) and (v.get("action_requests") or v.get("actionRequests")):
                    return v
        return None

    async def _send_approval_prompt(self, channel_id: str, thread_id: str, payload: dict):
        """Universal Tool Approval card for Slack with argument truncation and Always-Allow."""
        import json as _json
        reqs = payload.get("action_requests") or payload.get("actionRequests") or []
        if not reqs and (payload.get("name") or payload.get("tool_name")):
            reqs = [payload]
        req_count = max(1, len(reqs))
        req_data = reqs[0] if reqs else {}
        tool_name = req_data.get("name") or req_data.get("tool_name") or "tool"
        args = req_data.get("args") or req_data.get("arguments") or {}
        desc = req_data.get("description") or f"Tool '{tool_name}' requires human approval before running."



        # Cache approval info for this thread
        if not hasattr(self, "pending_tool_approvals"):
            self.pending_tool_approvals = {}
        self.pending_tool_approvals[thread_id] = {
            "tool_name": tool_name,
            "args": args,
            "desc": desc,
            "req_count": req_count,
        }


        # Format arguments with safe truncation (Slack max 3000 chars per block)
        args_lines = []
        if isinstance(args, dict) and args:
            for k, v in args.items():
                if isinstance(v, str):
                    val_str = (v[:120] + f"… ({len(v)} chars)") if len(v) > 120 else v
                elif isinstance(v, (int, float, bool)):
                    val_str = str(v)
                else:
                    dumped = _json.dumps(v)
                    val_str = (dumped[:120] + f"… ({len(dumped)} chars)") if len(dumped) > 120 else dumped
                args_lines.append(f"• *{k}*: `{val_str}`")
            formatted_args = "\n".join(args_lines)
        else:
            dumped = str(args)
            formatted_args = f"`{(dumped[:200] + '…') if len(dumped) > 200 else dumped}`"

        is_batch = len(reqs) > 1
        header = f"🛡️ *Tool Execution Permission Required*{' (Batch: ' + str(len(reqs)) + ' calls)' if is_batch else ''}"
        text = f"{header}\n🔧 *Tool:* `{tool_name}`\n📝 *Details:* {desc}\n📋 *Arguments:*\n{formatted_args}"

        # Strictly enforce Slack's 3000-character section text limit
        if len(text) > 2800:
            text = text[:2750] + "\n\n… *(truncated)*"

        blocks = [
            {"type": "section", "text": {"type": "mrkdwn", "text": text}},
            {
                "type": "actions",
                "elements": [
                    {"type": "button", "text": {"type": "plain_text", "text": "✅ Allow"},
                     "style": "primary", "action_id": f"tool_ok:{thread_id}", "value": thread_id},
                    {"type": "button", "text": {"type": "plain_text", "text": f"🔓 Always Allow {tool_name[:15]}"},
                     "action_id": f"tool_always:{thread_id}:{tool_name}", "value": thread_id},
                    {"type": "button", "text": {"type": "plain_text", "text": "❌ Deny"},
                     "style": "danger", "action_id": f"tool_no:{thread_id}", "value": thread_id},
                ],
            },
        ]
        try:
            await self.web_client.chat_postMessage(channel=channel_id, blocks=blocks, text=text[:2800])
        except Exception as e:
            logger.warning(f"Slack blocks postMessage failed: {e}. Falling back to plain text.")
            plain_fallback = f"🛡️ *Tool Approval Required: {tool_name}*\n{desc}"
            await self.web_client.chat_postMessage(channel=channel_id, text=plain_fallback)

    async def _persist_always_allow(self, tool_name: str):
        """Persist permission_mode='always_allow' for a tool in Supabase."""
        import json as _json
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(
                None,
                lambda: self._sync_persist_always_allow(tool_name)
            )
        except Exception as e:
            logger.warning(f"Failed to persist always_allow on Slack for {tool_name}: {e}")

    def _sync_persist_always_allow(self, tool_name: str):
        import json as _json
        mcp_res = supabase.table("mcp_tool_settings").select("id").eq("tool_key", tool_name).execute()
        if mcp_res.data and len(mcp_res.data) > 0:
            supabase.table("mcp_tool_settings").update({
                "permission_mode": "always_allow",
                "updated_at": "now()"
            }).eq("tool_key", tool_name).execute()
            perm_key = "mcp_tools_permission_modes"
        else:
            perm_key = "builtin_tools_permission_modes"

        query = supabase.table("agent_settings").select("value").eq("key", perm_key)
        if self.user_id:
            query = query.eq("user_id", self.user_id)
        current_res = query.maybe_single().execute()
        current_val = current_res.data.get("value") if current_res and current_res.data else {}
        perms = _json.loads(current_val) if isinstance(current_val, str) else (current_val or {})
        perms[tool_name] = "always_allow"

        upsert_payload = {
            "key": perm_key,
            "value": _json.dumps(perms),
            "updated_at": "now()"
        }
        if self.user_id:
            upsert_payload["user_id"] = self.user_id
        supabase.table("agent_settings").upsert(upsert_payload, on_conflict="key,user_id").execute()

    async def _resume_and_continue(self, channel_id: str, thread_id: str, resume_payload: dict):
        """Resume an interrupted run after an approval decision, then finish it."""
        session = self.active_sessions.get(channel_id)
        config = {
            "configurable": {
                "workflow_id": session["workflow_id"] if session else None,
                "user_id": self.user_id,
                "platform": "slack",
                "voice_mode": self.get_voice_mode(channel_id),
                "voice_input": False,
            }
        }
        placeholder = await self.web_client.chat_postMessage(channel=channel_id, text="🤖 _Continuing…_")
        msg_ts = placeholder.get("ts")
        accumulated_text = ""
        active_messages: dict = {}
        last_edit_time = 0.0
        last_edit_text = ""
        try:
            async for chunk in langgraph_client.runs.stream(
                thread_id=thread_id,
                assistant_id=RESOLVED_ASSISTANT_ID,
                command={"resume": resume_payload},
                config=config,
                stream_mode="messages",
                stream_subgraphs=True,
            ):
                if isinstance(chunk, dict):
                    event_type = chunk.get("event")
                    data = chunk.get("data", [])
                else:
                    event_type = getattr(chunk, "event", None)
                    data = getattr(chunk, "data", [])
                if event_type == "messages/partial":
                    for msg in data:
                        msg_id = msg.get("id") if isinstance(msg, dict) else getattr(msg, "id", None)
                        content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                        if msg_id and content:
                            active_messages[msg_id] = content
                    accumulated_text = "".join(active_messages.values())
                    if accumulated_text.strip() and msg_ts:
                        now = time.time()
                        if now - last_edit_time > 2.0 and accumulated_text.strip() != last_edit_text.strip():
                            try:
                                text_to_send = extract_audio_markers(accumulated_text)[-1]
                                if len(text_to_send) > 3000:
                                    text_to_send = text_to_send[:3000] + "\n\n... (truncated)"
                                await self.web_client.chat_update(channel=channel_id, ts=msg_ts, text=text_to_send + " ▉")
                                last_edit_text = accumulated_text
                                last_edit_time = now
                            except Exception as ue:
                                logger.warning(f"Slack chat_update warning: {ue}")
        except Exception as e:
            logger.exception("Error resuming run after approval decision")
            await self.web_client.chat_postMessage(channel=channel_id, text=f"❌ Failed to resume: {e}")
            return

        await self._finish_run(channel_id, thread_id, accumulated_text, msg_ts)

    async def _finish_run(self, channel_id: str, thread_id: str, streamed_text: str, msg_ts: str, thread_ts: str = None):
        """Tail of every run: pause for approval if interrupted, else deliver final
        text (markers stripped) plus any voice/audio reply file."""
        # 1. Pending human approval? (terminal tool interrupt)
        pending = await self._pending_interrupt(thread_id)
        if pending:
            if msg_ts:
                try:
                    await self.web_client.chat_update(channel=channel_id, ts=msg_ts, text="⏸️ Agent paused — needs your approval:")
                except Exception:
                    pass
            await self._send_approval_prompt(channel_id, thread_id, pending)
            return

        # 2. Final text from thread state
        audio_url, is_voice, final_text = None, False, streamed_text
        try:
            state = await langgraph_client.threads.get_state(thread_id)
            messages = (state.get("values", {}) or {}).get("messages", []) if isinstance(state, dict) else []
            latest_ai_msg = None
            for msg in reversed(messages):
                role = msg.get("type") or msg.get("role")
                if role in ("ai", "assistant"):
                    latest_ai_msg = msg
                    break

            if latest_ai_msg:
                content = latest_ai_msg.get("content", "")
                if isinstance(content, list):
                    content = "".join(
                        (b.get("text", "") if isinstance(b, dict) and b.get("type") == "text" else (b if isinstance(b, str) else ""))
                        for b in content
                    )
                if content.strip():
                    url_m, v_m, _provider, cleaned = extract_audio_markers(content)
                    if cleaned.strip():
                        final_text = cleaned
                    if url_m:
                        audio_url = url_m
                        is_voice = v_m
        except Exception as e:
            logger.warning(f"Final state fetch attempt failed: {e}")

        if audio_url is None and streamed_text:
            audio_url, is_voice, _provider, cleaned = extract_audio_markers(streamed_text)
            if audio_url:
                final_text = cleaned

        # 3. Update the placeholder with the final cleaned text
        if msg_ts:
            if final_text.strip():
                formatted_response = convert_markdown_to_slack(format_markdown_tables(final_text))
                if len(formatted_response) > 3000:
                    parts = []
                    temp = formatted_response
                    while temp:
                        parts.append(temp[:3000])
                        temp = temp[3000:]
                    await self.web_client.chat_update(
                        channel=channel_id,
                        ts=msg_ts,
                        text=parts[0] + f"\n\n*(Part 1/{len(parts)} - continued in thread)*"
                    )
                    parent_ts = thread_ts or msg_ts
                    for i, part in enumerate(parts[1:], start=2):
                        suffix = f"\n\n*(Part {i}/{len(parts)} - continued in thread)*" if i < len(parts) else ""
                        await self.web_client.chat_postMessage(channel=channel_id, thread_ts=parent_ts, text=part + suffix)
                else:
                    await self.web_client.chat_update(channel=channel_id, ts=msg_ts, text=formatted_response)
            else:
                await self.web_client.chat_update(channel=channel_id, ts=msg_ts, text="🤖 Done. (No response content was generated.)")

        # 4. Deliver the audio reply as an uploaded file
        if audio_url:
            try:
                import httpx
                async with httpx.AsyncClient(timeout=120.0) as http_client:
                    resp = await http_client.get(audio_url)
                    resp.raise_for_status()
                    audio_bytes = resp.content
                ext = audio_url.rsplit(".", 1)[-1][:4] or "mp3"
                await self.web_client.files_upload_v2(
                    channel=channel_id,
                    file=audio_bytes,
                    filename=f"voice_reply.{ext}",
                    title="🔊 Voice reply",
                )
            except Exception as e:
                logger.error(f"Failed to deliver audio reply on Slack: {e}")
                await self.web_client.chat_postMessage(channel=channel_id, text=f"🔊 Audio reply: {audio_url}")

    async def get_enabled_workflows(self) -> list[dict]:
        loop = asyncio.get_running_loop()
        try:
            resp = await loop.run_in_executor(
                None,
                lambda: supabase.rpc("get_backend_bootstrap_data").execute()
            )
            bootstrap = resp.data or {}
            all_workflows = bootstrap.get("workflows") or []
            filtered = [
                w for w in all_workflows
                if w.get("is_active") == True and (not self.user_id or str(w.get("user_id")) == str(self.user_id))
            ]
            return filtered
        except Exception as e:
            logger.error(f"Error fetching workflows for Slack via bootstrap: {e}")
            return []

    async def start(self):
        self.socket_client = SocketModeClient(
            app_token=self.app_token,
            web_client=self.web_client
        )
        self.socket_client.socket_mode_request_listeners.append(self.handle_slack_request)
        await self.socket_client.connect()
        self.is_running = True
        logger.info(f"Slack Socket Mode client started for connection {self.conn_id[:8]}.")

    async def stop(self):
        if self.socket_client:
            await self.socket_client.close()
        self.is_running = False
        logger.info(f"Slack Socket Mode client stopped for connection {self.conn_id[:8]}.")

    async def handle_slack_request(self, client: SocketModeClient, req: SocketModeRequest):
        if req.type == "events_api":
            # Acknowledge the request immediately
            await client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))
            
            event = req.payload.get("event", {})
            event_type = event.get("type")
            logger.info(f"Received Slack event: type={event_type}, subtype={event.get('subtype')}, bot_id={event.get('bot_id')}")
            
            # Filter out message edits, bot messages, etc.
            if event_type == "message" and not event.get("bot_id") and (not event.get("subtype") or event.get("subtype") == "file_share"):
                channel_id = event.get("channel")
                user_text = event.get("text", "").strip()
                files = event.get("files", [])
                thread_ts = event.get("thread_ts")
                
                if user_text or files:
                    asyncio.create_task(self.process_message(channel_id, user_text, files, thread_ts=thread_ts))

        elif req.type == "slash_commands":
            # Acknowledge the slash command request immediately
            await client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))
            
            payload = req.payload
            channel_id = payload.get("channel_id")
            command = payload.get("command", "")
            cmd_args = payload.get("text", "").strip()
            full_command_text = f"{command} {cmd_args}".strip()
            logger.info(f"Received Slack slash command: {full_command_text} in channel {channel_id}")
            if channel_id and full_command_text:
                asyncio.create_task(self.process_message(channel_id, full_command_text))

        elif req.type == "interactive":
            # Acknowledge the request immediately
            await client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))
            
            payload = req.payload
            actions = payload.get("actions", [])
            if actions:
                action = actions[0]
                action_id = action.get("action_id", "")
                if action_id.startswith("select_wf:"):
                    value = action.get("value", "")
                    if ":" in value:
                        workflow_id, workflow_name = value.split(":", 1)
                        channel_id = payload.get("channel", {}).get("id")
                        asyncio.create_task(self.switch_workflow(channel_id, workflow_id, workflow_name))
                elif action_id.startswith(("term_ok:", "term_no:", "tool_ok:", "tool_no:", "tool_always:")):
                    # Universal Tool / command approval decision (human-in-the-loop)
                    parts = action_id.split(":")
                    kind = parts[0]
                    thread_id = parts[1] if len(parts) > 1 else ""
                    tool_name = parts[2] if len(parts) > 2 else "tool"
                    channel_id = payload.get("channel", {}).get("id")
                    msg = payload.get("message", {})

                    if kind == "tool_always":
                        asyncio.create_task(self._persist_always_allow(tool_name))
                        decision = "approve"
                        mark = f"\n\n🔓 _Always Allowed for *{tool_name}* — executing…_"
                    elif kind in ("term_ok", "tool_ok"):
                        decision = "approve"
                        mark = "\n\n✅ _Allowed — executing…_"
                    else:
                        decision = "reject"
                        mark = "\n\n❌ _Denied — the agent has been told._"

                    base_text = (msg.get("text") or "").split("\n\n✅")[0].split("\n\n❌")[0].split("\n\n🔓")[0]
                    try:
                        await self.web_client.chat_update(
                            channel=channel_id,
                            ts=msg.get("ts"),
                            text=base_text + mark,
                            blocks=[{"type": "section", "text": {"type": "mrkdwn", "text": base_text + mark}}],
                        )
                    except Exception as ue:
                        logger.warning(f"Failed to update approval message: {ue}")
                    
                    cached_info = getattr(self, "pending_tool_approvals", {}).get(thread_id, {})
                    req_count = cached_info.get("req_count", 1)
                    if req_count <= 1:
                        try:
                            pending_state = await self._pending_interrupt(thread_id)
                            if pending_state:
                                state_reqs = pending_state.get("action_requests") or pending_state.get("actionRequests") or []
                                if state_reqs:
                                    req_count = len(state_reqs)
                        except Exception:
                            pass
                    req_count = max(1, req_count)

                    if decision == "approve":
                        decisions = [{"type": "approve"} for _ in range(req_count)]
                    else:
                        decisions = [{"type": "reject", "message": "User denied tool execution via Slack."} for _ in range(req_count)]

                    resume_payload = {"decisions": decisions}

                    asyncio.create_task(self._resume_and_continue(channel_id, thread_id, resume_payload))


    async def switch_workflow(self, channel_id: str, workflow_id: str, workflow_name: str):
        global RESOLVED_ASSISTANT_ID
        if not RESOLVED_ASSISTANT_ID:
            try:
                assistants = await langgraph_client.assistants.search()
                if assistants:
                    for a in assistants:
                        if a.get("name") == "research" or a.get("assistant_id") == "research":
                            RESOLVED_ASSISTANT_ID = a["assistant_id"]
                            break
                    else:
                        RESOLVED_ASSISTANT_ID = assistants[0]["assistant_id"]
                else:
                    RESOLVED_ASSISTANT_ID = "research"
            except Exception as ae:
                logger.error(f"Error searching assistants: {ae}")
                RESOLVED_ASSISTANT_ID = "research"

        # Create new LangGraph thread
        try:
            thread = await langgraph_client.threads.create(
                metadata={
                    "workflow_id": workflow_id,
                    "user_id": self.user_id,
                    "slack_channel_id": channel_id
                }
            )
            thread_id = thread["thread_id"]
        except Exception as e:
            logger.error(f"Failed to create thread: {e}")
            await self.web_client.chat_postMessage(
                channel=channel_id,
                text=f"❌ Failed to start thread with LangGraph: `{e}`"
            )
            return

        self.active_sessions[channel_id] = {
            "workflow_id": workflow_id,
            "workflow_name": workflow_name,
            "thread_id": thread_id
        }

        await self.web_client.chat_postMessage(
            channel=channel_id,
            text=f"✅ *{workflow_name}* is ready!\nThread ID: `{thread_id}`"
        )

    async def process_message(self, channel_id: str, text: str, files: list = None, thread_ts: str = None):
        global RESOLVED_ASSISTANT_ID
        text = text or ""
        logger.info(f"Received text from channel {channel_id}: {repr(text)} (files: {len(files) if files else 0})")
        # 1. Handle commands
        if text.startswith("/start") or text.startswith("/workflows") or text.startswith("!start") or text.startswith("!workflows"):
            workflows = await self.get_enabled_workflows()
            if not workflows:
                await self.web_client.chat_postMessage(
                    channel=channel_id,
                    text="❌ No active workflows found in database. Please configure workflows first."
                )
                return

            current_session = self.active_sessions.get(channel_id)
            if current_session:
                header_text = (
                    f"🔄 *Switch Workflow*\n\n"
                    f"Currently active: *{current_session['workflow_name']}*\n\n"
                    "Select a workflow below to start a *new conversation*:"
                )
            else:
                header_text = (
                    "👋 *Welcome to Deep Agents on Slack!*\n\n"
                    "Select a workflow to start a new conversation:"
                )

            # Construct Block Kit buttons
            blocks = [
                {
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": header_text
                    }
                },
                {
                    "type": "actions",
                    "elements": [
                        {
                            "type": "button",
                            "text": {
                                "type": "plain_text",
                                "text": f"🤖 {wf['name']}"
                            },
                            "value": f"{wf['id']}:{wf['name']}",
                            "action_id": f"select_wf:{wf['id']}"
                        }
                        for wf in workflows
                    ]
                }
            ]

            await self.web_client.chat_postMessage(
                channel=channel_id,
                blocks=blocks,
                text="Please select a workflow to start conversation."
            )
            return

        elif text.startswith("/select") or text.startswith("!select"):
            parts = text.split(" ", 1)
            if len(parts) < 2:
                await self.web_client.chat_postMessage(
                    channel=channel_id,
                    text="⚠️ Usage: `!select <workflow_name_or_id>`"
                )
                return

            target = parts[1].strip()
            workflows = await self.get_enabled_workflows()
            selected = None
            for wf in workflows:
                if wf["id"] == target or wf["name"].lower() == target.lower():
                    selected = wf
                    break

            if not selected:
                await self.web_client.chat_postMessage(
                    channel=channel_id,
                    text=f"❌ Workflow '{target}' not found. Send `!workflows` to see active list."
                )
                return

            await self.switch_workflow(channel_id, selected["id"], selected["name"])
            return

        # Slash and bang commands (/stop, /voice, /help, /new, /status, /start)
        # Agent commands (e.g. /learn) fall through to the agent.
        elif text.startswith(("/", "!")) and resolve_command is not None:
            parsed = resolve_command(text)
            if not parsed:
                await self.web_client.chat_postMessage(channel=channel_id, text="❓ Unknown command. Try `/help`")
                return
            cmd, args = parsed
            if cmd.kind == "agent":
                pass  # e.g. /learn — falls through to the agent below
            elif cmd.name in ("stop", "cancel", "abort"):
                cancelled = False
                if TaskTracker:
                    cancelled = await TaskTracker.cancel_run(channel_id)
                if cancelled:
                    await self.web_client.chat_postMessage(channel=channel_id, text="🛑 *Active execution stopped.*")
                else:
                    await self.web_client.chat_postMessage(channel=channel_id, text="ℹ️ No active agent task is currently running.")
                return
            elif cmd.name == "voice":
                mapping = {"on": "voice_only", "off": "off", "tts": "all"}
                mode = mapping.get(args.lower())
                if not mode:
                    await self.web_client.chat_postMessage(
                        channel=channel_id,
                        text="Usage: `/voice on` (speak replies to voice messages) · `/voice tts` (speak every reply) · `/voice off` (text only)"
                    )
                    return
                self.voice_modes[channel_id] = mode
                label = {
                    "voice_only": "ON — I'll speak replies to your voice messages 🎙️",
                    "off": "OFF — text only",
                    "all": "TTS — I'll speak every reply 🔊",
                }[mode]
                await self.web_client.chat_postMessage(channel=channel_id, text=f"Voice replies: *{label}*")
                return
            elif cmd.name == "help":
                await self.web_client.chat_postMessage(
                    channel=channel_id,
                    text="🤖 *Commands*\n\n" + "\n".join(cmd_help_lines()) + "\n\nNative: `/start` · `/select <workflow>`"
                )
                return
            elif cmd.name == "new":
                session = self.active_sessions.get(channel_id)
                if not session:
                    await self.web_client.chat_postMessage(channel=channel_id, text="No active workflow yet — send `/start` first.")
                    return
                try:
                    thread = await langgraph_client.threads.create(
                        metadata={"workflow_id": session["workflow_id"], "user_id": self.user_id, "slack_channel_id": channel_id}
                    )
                    session["thread_id"] = thread["thread_id"]
                    await self.web_client.chat_postMessage(channel=channel_id, text=f"🆕 Fresh conversation started with *{session['workflow_name']}*.")
                except Exception as e:
                    await self.web_client.chat_postMessage(channel=channel_id, text=f"❌ Couldn't start a new thread: {e}")
                return
            elif cmd.name in ("status",):
                session = self.active_sessions.get(channel_id)
                text_out = (f"📌 *Current Status*\n🤖 Workflow: `{session['workflow_name']}`\n🧵 Thread: `{session['thread_id']}`"
                            if session else "📌 *Current Status*\n❌ No active session.")
                await self.web_client.chat_postMessage(channel=channel_id, text=text_out)
                return


        # 2. Regular message routing
        session = self.active_sessions.get(channel_id)
        if not session:
            # Auto-select the first available workflow
            workflows = await self.get_enabled_workflows()
            if not workflows:
                await self.web_client.chat_postMessage(
                    channel=channel_id,
                    text="❌ No active workflows found in database. Please configure workflows first."
                )
                return
            
            selected = workflows[0]
            # Try to find "Default Workflow"
            for wf in workflows:
                if wf["name"].lower() == "default workflow":
                    selected = wf
                    break

            if not RESOLVED_ASSISTANT_ID:
                try:
                    assistants = await langgraph_client.assistants.search()
                    if assistants:
                        for a in assistants:
                            if a.get("name") == "research" or a.get("assistant_id") == "research":
                                RESOLVED_ASSISTANT_ID = a["assistant_id"]
                                break
                        else:
                            RESOLVED_ASSISTANT_ID = assistants[0]["assistant_id"]
                    else:
                        RESOLVED_ASSISTANT_ID = "research"
                except Exception as ae:
                    logger.error(f"Error searching assistants: {ae}")
                    RESOLVED_ASSISTANT_ID = "research"

            try:
                thread = await langgraph_client.threads.create(
                    metadata={
                        "workflow_id": selected["id"],
                        "user_id": self.user_id,
                        "slack_channel_id": channel_id
                    }
                )
                thread_id = thread["thread_id"]
            except Exception as e:
                logger.error(f"Failed to create thread: {e}")
                await self.web_client.chat_postMessage(
                    channel=channel_id,
                    text=f"❌ Failed to start thread with LangGraph: `{e}`"
                )
                return

            session = {
                "workflow_id": selected["id"],
                "workflow_name": selected["name"],
                "thread_id": thread_id
            }
            self.active_sessions[channel_id] = session
            await self.web_client.chat_postMessage(
                channel=channel_id,
                text=f"⚠️ *No active session.* Auto-started conversation with *{selected['name']}* (Thread ID: `{thread_id}`)."
            )

        workflow_id = session["workflow_id"]
        workflow_name = session["workflow_name"]
        thread_id = session["thread_id"]

        # Handle file downloads and uploads to Supabase
        attachments = []
        if files:
            import httpx
            import uuid
            async with httpx.AsyncClient(timeout=300.0) as http_client:
                for f in files:
                    url_private = f.get("url_private_download") or f.get("url_private")
                    name = f.get("name", "file")
                    mimetype = f.get("mimetype", "")
                    if not url_private:
                        continue
                    
                    try:
                        logger.info(f"Downloading file {name} from Slack URL: {url_private}...")
                        headers = {"Authorization": f"Bearer {self.bot_token}"}
                        resp = await http_client.get(url_private, headers=headers, follow_redirects=True)
                        resp.raise_for_status()
                        file_bytes = resp.content
                        logger.info(f"Downloaded {len(file_bytes)} bytes.")

                        # Upload to unified storage (R2-first, Supabase fallback)
                        from research_agent import storage_service

                        logger.info(f"Uploading file {name} to unified storage...")
                        loop = asyncio.get_running_loop()
                        file_url = await loop.run_in_executor(
                            None,
                            lambda: storage_service.upload_file(
                                data=file_bytes,
                                filename=name,
                                mime_type=mimetype,
                                category="uploads",
                                thread_id=thread_id,
                                user_id=self.user_id,
                            )
                        )
                        if not file_url:
                            raise RuntimeError("storage upload returned no URL (check R2/Supabase configuration)")
                        logger.info(f"Uploaded to storage: {file_url}")
                        
                        # Map to correct attachment dictionary for preflight capability sniffer
                        lower_name = name.lower()
                        if mimetype.startswith("image/") or lower_name.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
                            attachments.append({
                                "type": "image_url",
                                "image_url": {"url": file_url},
                                "filename": name
                            })
                        elif mimetype.startswith("audio/") or lower_name.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")):
                            attachments.append({
                                "type": "audio",
                                "audio": file_url,
                                "filename": name,
                                "mimeType": mimetype
                            })
                        elif mimetype.startswith("video/") or lower_name.endswith((".mp4", ".webm", ".mov", ".avi")):
                            attachments.append({
                                "type": "video",
                                "video": file_url,
                                "filename": name,
                                "mimeType": mimetype
                            })
                        else:
                            attachments.append({
                                "type": "file",
                                "data": file_url,
                                "filename": name,
                                "mimeType": mimetype
                            })
                    except Exception as upload_err:
                        logger.error(f"Error handling Slack attachment {name}: {upload_err}")
                        await self.web_client.chat_postMessage(
                            channel=channel_id,
                            text=f"⚠️ Failed to process file attachment `{name}`: {upload_err}"
                        )

        # Post placeholder message
        post_args = {
            "channel": channel_id,
            "text": f"🤖 _[{workflow_name}] Thinking..._"
        }
        if thread_ts:
            post_args["thread_ts"] = thread_ts
            
        placeholder_resp = await self.web_client.chat_postMessage(**post_args)
        msg_ts = placeholder_resp.get("ts")

        if attachments:
            content_list = []
            if text:
                content_list.append({"type": "text", "text": text})
            for att in attachments:
                content_list.append(att)
            input_data = {"messages": [{"role": "user", "content": content_list}]}
        else:
            input_data = {"messages": [{"role": "user", "content": text}]}
        config = {
            "configurable": {
                "workflow_id": workflow_id,
                "user_id": self.user_id,
                "platform": "slack",
                "voice_mode": self.get_voice_mode(channel_id),
                "voice_input": any(a.get("type") == "audio" for a in attachments),
            }
        }

        accumulated_text = ""
        last_edit_text = ""
        last_edit_time = 0.0
        active_messages = {}

        current_task = asyncio.current_task()
        if TaskTracker and current_task:
            await TaskTracker.register_run(channel_id, current_task, client=langgraph_client, thread_id=thread_id)

        try:
            try:
                async for chunk in langgraph_client.runs.stream(
                    thread_id=thread_id,
                    assistant_id=RESOLVED_ASSISTANT_ID,
                    input=input_data,
                    config=config,
                    stream_mode="messages",
                    stream_subgraphs=True,
                ):
                    if isinstance(chunk, dict):
                        event_type = chunk.get("event")
                        data = chunk.get("data", [])
                    else:
                        event_type = getattr(chunk, "event", None)
                        data = getattr(chunk, "data", [])

                    logger.info(f"Stream event: {event_type}")

                    if event_type == "messages/partial":
                        for msg in data:
                            msg_id = msg.get("id") if isinstance(msg, dict) else getattr(msg, "id", None)
                            content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                            if msg_id and content:
                                active_messages[msg_id] = content
                        
                        accumulated_text = "".join(active_messages.values())
                        if accumulated_text.strip():
                            now = time.time()
                            if now - last_edit_time > 2.0 and accumulated_text.strip() != last_edit_text.strip():
                                try:
                                    text_to_send = extract_audio_markers(accumulated_text)[-1]
                                    if len(text_to_send) > 3000:
                                        text_to_send = text_to_send[:3000] + "\n\n... (truncated)"
                                    await self.web_client.chat_update(
                                        channel=channel_id,
                                        ts=msg_ts,
                                        text=text_to_send + " ▉"
                                    )
                                    last_edit_text = accumulated_text
                                    last_edit_time = now
                                except Exception as ue:
                                    logger.warning(f"Slack chat_update warning: {ue}")
            except Exception as stream_err:
                from langgraph_sdk.errors import NotFoundError
                if isinstance(stream_err, NotFoundError) or "not found" in str(stream_err).lower():
                    logger.warning("Thread not found on LangGraph. Creating a new thread and retrying...")
                    new_thread = await langgraph_client.threads.create(
                        metadata={
                            "workflow_id": workflow_id,
                            "user_id": self.user_id,
                            "slack_channel_id": channel_id
                        }
                    )
                    thread_id = new_thread["thread_id"]
                    session["thread_id"] = thread_id
                    
                    # Retry
                    active_messages.clear()
                    async for chunk in langgraph_client.runs.stream(
                        thread_id=thread_id,
                        assistant_id=RESOLVED_ASSISTANT_ID,
                        input=input_data,
                        config=config,
                        stream_mode="messages",
                        stream_subgraphs=True,
                    ):
                        if isinstance(chunk, dict):
                            event_type = chunk.get("event")
                            data = chunk.get("data", [])
                        else:
                            event_type = getattr(chunk, "event", None)
                            data = getattr(chunk, "data", [])

                        logger.info(f"Stream event: {event_type}")

                        if event_type == "messages/partial":
                            for msg in data:
                                msg_id = msg.get("id") if isinstance(msg, dict) else getattr(msg, "id", None)
                                content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                                if msg_id and content:
                                    active_messages[msg_id] = content
                            
                            accumulated_text = "".join(active_messages.values())
                            if accumulated_text.strip():
                                now = time.time()
                                if now - last_edit_time > 2.0 and accumulated_text.strip() != last_edit_text.strip():
                                    try:
                                        text_to_send = extract_audio_markers(accumulated_text)[-1]
                                        if len(text_to_send) > 3000:
                                            text_to_send = text_to_send[:3000] + "\n\n... (truncated)"
                                        await self.web_client.chat_update(
                                            channel=channel_id,
                                            ts=msg_ts,
                                            text=text_to_send + " ▉"
                                        )
                                        last_edit_text = accumulated_text
                                        last_edit_time = now
                                    except Exception as ue:
                                        logger.warning(f"Slack chat_update warning: {ue}")
                else:
                    raise stream_err

            # Final delivery / approval pause (state is source of truth — the voice
            # mirror appends AUDIO_URL markers after streaming finishes)
            await self._finish_run(channel_id, thread_id, accumulated_text, msg_ts, thread_ts=thread_ts)

        except asyncio.CancelledError:
            logger.info(f"Stream cancelled for slack channel_id={channel_id}")
            try:
                await self.web_client.chat_update(
                    channel=channel_id,
                    ts=msg_ts,
                    text="🛑 *Execution cancelled by user.*"
                )
            except Exception:
                pass
        except Exception as e:
            logger.exception("Error processing message in Slack daemon")
            await self.web_client.chat_update(
                channel=channel_id,
                ts=msg_ts,
                text=f"❌ *Execution Failed:*\n`{e}`"
            )
        finally:
            if TaskTracker:
                await TaskTracker.unregister_run(channel_id)



running_bots = {}  # conn_id -> SlackBotInstance


async def slack_coordinator():
    logger.info("Starting Slack Bot Coordinator...")
    while True:
        try:
            # Query active slack connections
            resp = supabase.table("slack_connections").select("id, bot_token, app_token, user_id, is_active").eq("is_active", True).execute()
            active_connections = resp.data or []
            active_ids = {conn["id"] for conn in active_connections}

            # Stop inactive ones
            to_stop = [cid for cid in list(running_bots.keys()) if cid not in active_ids]
            for cid in to_stop:
                instance = running_bots[cid]
                await instance.stop()
                del running_bots[cid]

            # Start new ones
            for conn in active_connections:
                cid = conn["id"]
                if cid not in running_bots:
                    instance = SlackBotInstance(
                        conn_id=cid,
                        bot_token=conn["bot_token"],
                        app_token=conn["app_token"],
                        user_id=conn["user_id"]
                    )
                    running_bots[cid] = instance
                    asyncio.create_task(instance.start())
                    logger.info(f"Spawned Slack bot instance for connection {cid[:8]}")

        except Exception as e:
            logger.error(f"Error in Slack coordinator tick: {e}")

        await asyncio.sleep(10)


if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(slack_coordinator())
    except KeyboardInterrupt:
        logger.info("Slack server shutdown by KeyboardInterrupt.")
