#!/usr/bin/env python3
"""
discord_server.py — Multi-tenant Discord bot manager for Deep Agents.
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
logger = logging.getLogger("discord_server")

# Check required libraries
try:
    import discord
    from discord.ext import commands
except ImportError:
    logger.error("discord.py is not installed. Run: uv pip install discord.py")
    sys.exit(1)

try:
    from supabase import create_client, Client
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
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    logger.info("Supabase client initialized successfully.")
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


# ── Markdown Table to ASCII Renderer ──────────────────────────────────────────

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


class ApprovalView(discord.ui.View):
    """Inline Allow / Always Allow / Deny buttons for tool execution approval interrupts."""

    def __init__(self, instance: "DiscordBotInstance", channel, thread_id: str, tool_name: str = "tool", req_count: int = 1, timeout: float = 900):
        super().__init__(timeout=timeout)
        self.instance = instance
        self.channel = channel
        self.thread_id = thread_id
        self.tool_name = tool_name
        self.req_count = max(1, req_count)
        self.decided = False

    async def _decide(self, interaction: discord.Interaction, decision_type: str, always_allow: bool = False):
        if self.decided:
            await interaction.response.send_message("Already decided.", ephemeral=True)
            return
        self.decided = True
        if always_allow:
            asyncio.create_task(self.instance._persist_always_allow(self.tool_name))
            mark = f"🔓 *Always Allowed for {self.tool_name} — executing…*"
        elif decision_type == "approve":
            mark = "✅ *Allowed — executing…*"
        else:
            mark = "❌ *Denied — the agent has been told.*"
        await interaction.response.edit_message(content=interaction.message.content + "\n\n" + mark, view=None)
        
        if decision_type == "approve":
            decisions = [{"type": "approve"} for _ in range(self.req_count)]
        else:
            decisions = [{"type": "reject", "message": "User denied tool execution via Discord."} for _ in range(self.req_count)]

        resume_payload = {"decisions": decisions}
        asyncio.create_task(
            self.instance._resume_and_continue(
                self.channel, self.thread_id, resume_payload
            )
        )


    @discord.ui.button(label="✅ Allow", style=discord.ButtonStyle.success, custom_id="tool_ok")
    async def approve(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._decide(interaction, "approve")

    @discord.ui.button(label="🔓 Always Allow", style=discord.ButtonStyle.secondary, custom_id="tool_always")
    async def always_allow(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._decide(interaction, "approve", always_allow=True)

    @discord.ui.button(label="❌ Deny", style=discord.ButtonStyle.danger, custom_id="tool_no")
    async def deny(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._decide(interaction, "reject")


class DiscordBotInstance:
    def __init__(self, conn_id: str, token: str, user_id: str):
        self.conn_id = conn_id
        self.token = token
        self.user_id = user_id
        self.bot = None
        self.active_sessions = {}  # channel_id -> {workflow_id, workflow_name, thread_id}
        self.voice_modes = {}      # channel_id -> "off" | "voice_only" | "all"
        self.task = None

    def get_voice_mode(self, channel_id: str) -> str:
        return self.voice_modes.get(channel_id, "voice_only")

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
            logger.warning(f"Failed to persist always_allow on Discord for {tool_name}: {e}")

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


    async def get_enabled_workflows(self) -> list[dict]:
        loop = asyncio.get_running_loop()
        try:
            resp = await loop.run_in_executor(
                None,
                lambda: supabase.table("workflows")
                .select("id, name")
                .eq("is_active", True)
                .order("created_at", desc=False)
                .execute()
            )
            return resp.data or []
        except Exception as e:
            logger.error(f"Error fetching workflows for Discord: {e}")
            return []

    async def start(self):
        intents = discord.Intents.default()
        intents.message_content = True
        
        self.bot = commands.Bot(command_prefix="!", intents=intents, help_command=None)

        @self.bot.event
        async def on_ready():
            logger.info(f"Discord Bot {self.bot.user.name} ({self.bot.user.id}) ready.")

        @self.bot.event
        async def on_message(message):
            if message.author.bot:
                return
            
            text = message.content.strip()
            if not text:
                return

            # Process message in background task
            asyncio.create_task(self.process_message(message.channel, text))

        self.task = asyncio.create_task(self.bot.start(self.token))

    async def stop(self):
        if self.bot:
            await self.bot.close()
        if self.task:
            self.task.cancel()
        logger.info(f"Discord bot instance stopped for connection {self.conn_id[:8]}")

    async def process_message(self, channel, text: str):
        global RESOLVED_ASSISTANT_ID
        channel_id = str(channel.id)

        # 1. Handle commands
        if text.startswith("!start") or text.startswith("!workflows"):
            workflows = await self.get_enabled_workflows()
            if not workflows:
                await channel.send("❌ No active workflows found in database. Please configure workflows first.")
                return

            workflow_list = "\n".join([f"• `{wf['name']}` (ID: `{wf['id']}`)" for wf in workflows])
            msg = (
                "👋 **Welcome to Deep Agents on Discord!**\n\n"
                "**Available Workflows:**\n"
                f"{workflow_list}\n\n"
                "To select or switch, send: `!select <workflow_name_or_id>`"
            )
            await channel.send(msg)
            return

        elif text.startswith("!select"):
            parts = text.split(" ", 1)
            if len(parts) < 2:
                await channel.send("⚠️ Usage: `!select <workflow_name_or_id>`")
                return

            target = parts[1].strip()
            workflows = await self.get_enabled_workflows()
            selected = None
            for wf in workflows:
                if wf["id"] == target or wf["name"].lower() == target.lower():
                    selected = wf
                    break

            if not selected:
                await channel.send(f"❌ Workflow '{target}' not found. Send `!workflows` to see active list.")
                return

            # Resolve assistant ID once
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
                        "workflow_id": selected["id"],
                        "user_id": self.user_id,
                        "discord_channel_id": channel_id
                    }
                )
                thread_id = thread["thread_id"]
            except Exception as e:
                logger.error(f"Failed to create thread: {e}")
                await channel.send(f"❌ Failed to start thread with LangGraph: `{e}`")
                return

            self.active_sessions[channel_id] = {
                "workflow_id": selected["id"],
                "workflow_name": selected["name"],
                "thread_id": thread_id
            }

            await channel.send(f"✅ **{selected['name']}** is ready!\nThread ID: `{thread_id}`")
            return

        # Slash and bang commands (/stop, /voice, /help, /new, /status, /start)
        # Agent commands (e.g. /learn) fall through to the agent, where the graph rewrites them.
        elif text.startswith(("/", "!")) and resolve_command is not None:
            parsed = resolve_command(text)
            if not parsed:
                await channel.send("❓ Unknown command. Try `/help`")
                return
            cmd, args = parsed
            if cmd.kind == "agent":
                pass  # falls through to the agent below
            elif cmd.name in ("stop", "cancel", "abort"):
                cancelled = False
                if TaskTracker:
                    cancelled = await TaskTracker.cancel_run(channel_id)
                if cancelled:
                    await channel.send("🛑 **Active execution stopped.**")
                else:
                    await channel.send("ℹ️ No active agent task is currently running.")
                return
            elif cmd.name == "voice":
                mapping = {"on": "voice_only", "off": "off", "tts": "all"}
                mode = mapping.get(args.lower())
                if not mode:
                    await channel.send("Usage: `/voice on` (speak replies to voice messages) · `/voice tts` (speak every reply) · `/voice off` (text only)")
                    return
                self.voice_modes[channel_id] = mode
                label = {
                    "voice_only": "ON — I'll speak replies to your voice messages 🎙️",
                    "off": "OFF — text only",
                    "all": "TTS — I'll speak every reply 🔊",
                }[mode]
                await channel.send(f"Voice replies: **{label}**")
                return
            elif cmd.name == "help":
                await channel.send("🤖 **Commands**\n\n" + "\n".join(cmd_help_lines()) + "\n\nNative: `/start` · `/select <workflow>`")
                return
            elif cmd.name == "new":
                session = self.active_sessions.get(channel_id)
                if not session:
                    await channel.send("No active workflow yet — send `/start` first.")
                    return
                try:
                    thread = await langgraph_client.threads.create(
                        metadata={"workflow_id": session["workflow_id"], "user_id": self.user_id, "discord_channel_id": channel_id}
                    )
                    session["thread_id"] = thread["thread_id"]
                    await channel.send(f"🆕 Fresh conversation started with **{session['workflow_name']}**.")
                except Exception as e:
                    await channel.send(f"❌ Couldn't start a new thread: {e}")
                return
            elif cmd.name == "status":
                session = self.active_sessions.get(channel_id)
                text_out = (f"📌 **Current Status**\n🤖 Workflow: `{session['workflow_name']}`\n🧵 Thread: `{session['thread_id']}`"
                            if session else "📌 **Current Status**\n❌ No active session.")
                await channel.send(text_out)
                return


        # 2. Regular message routing
        session = self.active_sessions.get(channel_id)
        if not session:
            workflows = await self.get_enabled_workflows()
            if not workflows:
                await channel.send("❌ No active workflows found in database. Please configure workflows first.")
                return
            
            selected = workflows[0]
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
                        "discord_channel_id": channel_id
                    }
                )
                thread_id = thread["thread_id"]
            except Exception as e:
                logger.error(f"Failed to create thread: {e}")
                await channel.send(f"❌ Failed to start thread with LangGraph: `{e}`")
                return

            session = {
                "workflow_id": selected["id"],
                "workflow_name": selected["name"],
                "thread_id": thread_id
            }
            self.active_sessions[channel_id] = session
            await channel.send(f"⚠️ *No active session.* Auto-started conversation with **{selected['name']}** (Thread ID: `{thread_id}`).")

        workflow_id = session["workflow_id"]
        workflow_name = session["workflow_name"]
        thread_id = session["thread_id"]

        # Send placeholder message
        placeholder_msg = await channel.send(f"🤖 _[{workflow_name}] Thinking..._")

        input_data = {"messages": [{"role": "user", "content": text}]}
        config = {
            "configurable": {
                "workflow_id": workflow_id,
                "user_id": self.user_id,
                "platform": "discord",
                "voice_mode": self.get_voice_mode(channel_id),
                "voice_input": False,
            }
        }

        accumulated_text = ""
        last_edit_text = ""
        last_edit_time = 0.0

        current_task = asyncio.current_task()
        if TaskTracker and current_task:
            await TaskTracker.register_run(channel_id, current_task, client=langgraph_client, thread_id=thread_id)

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

                if event_type == "messages/partial":
                    for msg in data:
                        content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                        if content:
                            accumulated_text += content
                            now = time.time()
                            if now - last_edit_time > 2.0 and accumulated_text.strip() != last_edit_text.strip():
                                try:
                                    # Discord limits message length to 2000 characters
                                    preview = (extract_audio_markers(accumulated_text)[-1][:1900] + " ▉")
                                    await placeholder_msg.edit(content=preview)
                                    last_edit_text = accumulated_text
                                    last_edit_time = now
                                except Exception:
                                    pass

            # Final delivery / approval pause (state is source of truth — the voice
            # mirror appends AUDIO_URL markers after streaming finishes)
            await self._finish_run(channel, channel_id, thread_id, accumulated_text, placeholder_msg)

        except asyncio.CancelledError:
            logger.info(f"Stream cancelled for channel_id={channel_id}")
            try:
                await placeholder_msg.edit(content="🛑 **Execution cancelled by user.**")
            except Exception:
                pass
        except Exception as e:
            logger.exception("Error processing message in Discord daemon")
            await placeholder_msg.edit(content=f"❌ *Execution Failed:*\n`{e}`")
        finally:
            if TaskTracker:
                await TaskTracker.unregister_run(channel_id)


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

    async def _resume_and_continue(self, channel, thread_id: str, resume_payload: dict):
        """Resume an interrupted run after an approval decision, then finish it."""
        channel_id = str(channel.id)
        session = self.active_sessions.get(channel_id)
        config = {
            "configurable": {
                "workflow_id": session["workflow_id"] if session else None,
                "user_id": self.user_id,
                "platform": "discord",
                "voice_mode": self.get_voice_mode(channel_id),
                "voice_input": False,
            }
        }
        placeholder_msg = await channel.send("🤖 _Continuing…_")
        accumulated_text = ""
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
                        content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                        if content:
                            accumulated_text += content
                            now = time.time()
                            if now - last_edit_time > 2.0 and accumulated_text.strip() != last_edit_text.strip():
                                try:
                                    await placeholder_msg.edit(content=extract_audio_markers(accumulated_text)[-1][:1900] + " ▉")
                                    last_edit_text = accumulated_text
                                    last_edit_time = now
                                except Exception:
                                    pass
        except Exception as e:
            logger.exception("Error resuming run after approval decision")
            await channel.send(f"❌ Failed to resume: {e}")
            return

        await self._finish_run(channel, channel_id, thread_id, accumulated_text, placeholder_msg)

    async def _finish_run(self, channel, channel_id: str, thread_id: str, streamed_text: str, placeholder_msg):
        """Tail of every run: pause for approval if interrupted, else deliver final
        text (markers stripped) plus any voice/audio reply file."""
        # 1. Pending human approval? (universal tool approval interrupt)
        pending = await self._pending_interrupt(thread_id)
        if pending:
            try:
                await placeholder_msg.edit(content="⏸️ Agent paused — needs your approval:")
            except Exception:
                pass
            import json as _json
            reqs = pending.get("action_requests") or pending.get("actionRequests") or []
            if not reqs and (pending.get("name") or pending.get("tool_name")):
                reqs = [pending]
            req_data = reqs[0] if reqs else {}
            tool_name = req_data.get("name") or req_data.get("tool_name") or "tool"
            args = req_data.get("args") or req_data.get("arguments") or {}
            desc = req_data.get("description") or f"Tool '{tool_name}' requires human approval before running."

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
                    args_lines.append(f"• **{k}**: `{val_str}`")
                formatted_args = "\n".join(args_lines)
            else:
                dumped = str(args)
                formatted_args = f"`{(dumped[:200] + '…') if len(dumped) > 200 else dumped}`"

            prompt_text = (
                f"🛡️ **Tool Execution Permission Required**\n"
                f"🔧 **Tool:** `{tool_name}`\n"
                f"📝 **Details:** {desc}\n"
                f"📋 **Arguments:**\n{formatted_args}"
            )
            await channel.send(
                prompt_text[:1950],
                view=ApprovalView(self, channel, thread_id, tool_name=tool_name, req_count=len(reqs)),
            )

            return

        # 2. Final text from thread state (includes voice-mirror markers appended
        #    after streaming); fall back to the streamed text
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
                    audio_url, is_voice, _provider, cleaned = extract_audio_markers(content)
                    if cleaned.strip():
                        final_text = cleaned
        except Exception as e:
            logger.warning(f"Final state fetch failed (using streamed text): {e}")
        if audio_url is None and streamed_text:
            audio_url, is_voice, _provider, cleaned = extract_audio_markers(streamed_text)
            if audio_url:
                final_text = cleaned

        # 3. Update the placeholder with the final cleaned text (2000-char limit)
        if final_text.strip():
            formatted_response = format_markdown_tables(final_text)
            if len(formatted_response) > 1950:
                chunks = [formatted_response[i:i+1950] for i in range(0, len(formatted_response), 1950)]
                await placeholder_msg.edit(content=chunks[0])
                for other_chunk in chunks[1:]:
                    await channel.send(other_chunk)
            else:
                await placeholder_msg.edit(content=formatted_response)
        else:
            await placeholder_msg.edit(content="🤖 Done. (No response content was generated.)")

        # 4. Deliver the audio reply as a file
        if audio_url:
            try:
                import httpx
                import io as _io
                async with httpx.AsyncClient(timeout=120.0) as http_client:
                    resp = await http_client.get(audio_url)
                    resp.raise_for_status()
                    audio_bytes = resp.content
                ext = audio_url.rsplit(".", 1)[-1][:4] or "mp3"
                await channel.send(
                    "🔊 Voice reply:",
                    file=discord.File(_io.BytesIO(audio_bytes), filename=f"voice_reply.{ext}"),
                )
            except Exception as e:
                logger.error(f"Failed to deliver audio reply on Discord: {e}")
                await channel.send(f"🔊 Audio reply: {audio_url}")


running_bots = {}  # conn_id -> DiscordBotInstance


async def discord_coordinator():
    logger.info("Starting Discord Bot Coordinator...")
    while True:
        try:
            # Query active Discord connections
            resp = supabase.table("discord_connections").select("id, bot_token, user_id, is_active").eq("is_active", True).execute()
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
                    instance = DiscordBotInstance(
                        conn_id=cid,
                        token=conn["bot_token"],
                        user_id=conn["user_id"]
                    )
                    running_bots[cid] = instance
                    asyncio.create_task(instance.start())
                    logger.info(f"Spawned Discord bot instance for connection {cid[:8]}")

        except Exception as e:
            logger.error(f"Error in Discord coordinator tick: {e}")

        await asyncio.sleep(10)


if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(discord_coordinator())
    except KeyboardInterrupt:
        logger.info("Discord server shutdown by KeyboardInterrupt.")
