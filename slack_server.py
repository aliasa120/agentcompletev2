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
        self.is_running = False

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

                        # Upload to Supabase Storage
                        file_ext = name.split(".")[-1].lower() if "." in name else ""
                        unique_filename = f"{uuid.uuid4()}.{file_ext}" if file_ext else str(uuid.uuid4())
                        
                        logger.info(f"Uploading file {name} to Supabase as {unique_filename}...")
                        loop = asyncio.get_running_loop()
                        await loop.run_in_executor(
                            None,
                            lambda: supabase.storage.from_("uploads").upload(
                                path=unique_filename,
                                file=file_bytes,
                                file_options={"content-type": mimetype}
                            )
                        )
                        
                        file_url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/public/uploads/{unique_filename}"
                        logger.info(f"Uploaded to Supabase: {file_url}")
                        
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
                "user_id": self.user_id
            }
        }

        accumulated_text = ""
        last_edit_text = ""
        last_edit_time = 0.0
        active_messages = {}

        try:
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
                            msg_id = msg.get("id") if isinstance(msg, dict) else getattr(msg, "id", None)
                            content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                            if msg_id and content:
                                active_messages[msg_id] = content
                        
                        accumulated_text = "".join(active_messages.values())
                        if accumulated_text.strip():
                            now = time.time()
                            if now - last_edit_time > 2.0 and accumulated_text.strip() != last_edit_text.strip():
                                try:
                                    text_to_send = accumulated_text
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
                                msg_id = msg.get("id") if isinstance(msg, dict) else getattr(msg, "id", None)
                                content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                                if msg_id and content:
                                    active_messages[msg_id] = content
                            
                            accumulated_text = "".join(active_messages.values())
                            if accumulated_text.strip():
                                now = time.time()
                                if now - last_edit_time > 2.0 and accumulated_text.strip() != last_edit_text.strip():
                                    try:
                                        text_to_send = accumulated_text
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
                formatted_response = convert_markdown_to_slack(formatted_response)
                if len(formatted_response) > 3000:
                    parts = []
                    temp = formatted_response
                    while temp:
                        parts.append(temp[:3000])
                        temp = temp[3000:]
                    
                    # Update the main message with Part 1
                    await self.web_client.chat_update(
                        channel=channel_id,
                        ts=msg_ts,
                        text=parts[0] + f"\n\n*(Part 1/{len(parts)} - continued in thread)*"
                    )
                    
                    # Post the rest of the parts as replies in the thread
                    parent_ts = thread_ts or msg_ts
                    for i, part in enumerate(parts[1:], start=2):
                        suffix = f"\n\n*(Part {i}/{len(parts)} - continued in thread)*" if i < len(parts) else ""
                        await self.web_client.chat_postMessage(
                            channel=channel_id,
                            thread_ts=parent_ts,
                            text=part + suffix
                        )
                else:
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
