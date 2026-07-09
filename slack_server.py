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
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "").strip()
LANGGRAPH_API_URL = os.environ.get("LANGGRAPH_API_URL", "http://localhost:2024").strip()

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    logger.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env")
    sys.exit(1)

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
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


class SlackBotInstance:
    def __init__(self, conn_id: str, bot_token: str, app_token: str, user_id: str):
        self.conn_id = conn_id
        self.bot_token = bot_token
        self.app_token = app_token
        self.user_id = user_id
        self.web_client = AsyncWebClient(token=self.bot_token)
        self.socket_client = None
        self.active_sessions = {}  # channel_id -> {workflow_id, workflow_name, thread_id}
        self.is_running = False

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
            logger.error(f"Error fetching workflows for Slack: {e}")
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
            
            # Filter out message edits, bot messages, etc.
            if event_type == "message" and not event.get("bot_id") and not event.get("subtype"):
                channel_id = event.get("channel")
                user_text = event.get("text", "").strip()
                
                if user_text:
                    asyncio.create_task(self.process_message(channel_id, user_text))

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

    async def process_message(self, channel_id: str, text: str):
        global RESOLVED_ASSISTANT_ID
        logger.info(f"Received text from channel {channel_id}: {repr(text)}")
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

        # Post placeholder message
        placeholder_resp = await self.web_client.chat_postMessage(
            channel=channel_id,
            text=f"🤖 _[{workflow_name}] Thinking..._"
        )
        msg_ts = placeholder_resp.get("ts")

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

                logger.info(f"Stream event: {event_type}")

                if event_type == "messages/partial":
                    for msg in data:
                        content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                        if content:
                            accumulated_text += content
                            now = time.time()
                            if now - last_edit_time > 2.0 and accumulated_text.strip() != last_edit_text.strip():
                                try:
                                    await self.web_client.chat_update(
                                        channel=channel_id,
                                        ts=msg_ts,
                                        text=accumulated_text + " ▉"
                                    )
                                    last_edit_text = accumulated_text
                                    last_edit_time = now
                                except Exception as ue:
                                    logger.warning(f"Slack chat_update warning: {ue}")

            # Fallback recovery
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
                await self.web_client.chat_update(
                    channel=channel_id,
                    ts=msg_ts,
                    text=formatted_response
                )
            else:
                await self.web_client.chat_update(
                    channel=channel_id,
                    ts=msg_ts,
                    text="🤖 Done. (No response content was generated.)"
                )

        except Exception as e:
            logger.exception("Error processing message in Slack daemon")
            await self.web_client.chat_update(
                channel=channel_id,
                ts=msg_ts,
                text=f"❌ *Execution Failed:*\n`{e}`"
            )


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
