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


class DiscordBotInstance:
    def __init__(self, conn_id: str, token: str, user_id: str):
        self.conn_id = conn_id
        self.token = token
        self.user_id = user_id
        self.bot = None
        self.active_sessions = {}  # channel_id -> {workflow_id, workflow_name, thread_id}
        self.task = None

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
                "user_id": self.user_id
            }
        }

        accumulated_text = ""
        last_edit_text = ""
        last_edit_time = 0.0

        try:
            async for chunk in langgraph_client.runs.stream(
                thread_id=thread_id,
                assistant_id=RESOLVED_ASSISTANT_ID,
                input=input_data,
                config=config,
                stream_mode="messages"
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
                                    preview = (accumulated_text[:1900] + " ▉")
                                    await placeholder_msg.edit(content=preview)
                                    last_edit_text = accumulated_text
                                    last_edit_time = now
                                except Exception:
                                    pass

            # Fallback state recovery
            if not accumulated_text.strip():
                try:
                    state = await langgraph_client.threads.get_state(thread_id)
                    values = state.get("values", {})
                    messages = values.get("messages", [])
                    if messages:
                        for msg in reversed(messages):
                            role = msg.get("type") or msg.get("role")
                            if role in ("ai", "assistant"):
                                accumulated_text = msg.get("content", "")
                                break
                except Exception as fe:
                    logger.error(f"Fallback state recovery failed: {fe}")

            if accumulated_text.strip():
                formatted_response = format_markdown_tables(accumulated_text)
                # Split if larger than 2000 characters
                if len(formatted_response) > 1950:
                    chunks = [formatted_response[i:i+1950] for i in range(0, len(formatted_response), 1950)]
                    await placeholder_msg.edit(content=chunks[0])
                    for other_chunk in chunks[1:]:
                        await channel.send(other_chunk)
                else:
                    await placeholder_msg.edit(content=formatted_response)
            else:
                await placeholder_msg.edit(content="🤖 Done. (No response content was generated.)")

        except Exception as e:
            logger.exception("Error processing message in Discord daemon")
            await placeholder_msg.edit(content=f"❌ *Execution Failed:*\n`{e}`")


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
