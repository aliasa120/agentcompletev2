#!/usr/bin/env python3
"""
telegram_server.py — Multi-tenant dynamic Telegram bot manager for Deep Agents.

This script:
1. Connects to Supabase to fetch bot tokens and bindings.
2. Dynamically spawns and stops bot polling tasks as bots are added/removed in the UI.
3. Coordinates message requests to the LangGraph API Server (default http://localhost:2024).
4. Supports multi-workflow routing per bot: /start shows an inline keyboard of all
   enabled workflows. Tapping one creates a NEW thread for that workflow.
5. Each chat_id has its own active session (workflow_id + thread_id) stored in memory.
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
logger = logging.getLogger("telegram_server")

# Check required libraries
try:
    from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, BotCommand
    from telegram.ext import (
        Application,
        CommandHandler,
        MessageHandler,
        CallbackQueryHandler,
        filters,
        ContextTypes
    )
except ImportError:
    logger.error("python-telegram-bot is not installed. Run: uv pip install python-telegram-bot")
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
    from research_agent.commands import resolve_command, help_lines as cmd_help_lines, COMMAND_REGISTRY
    from research_agent.tts import extract_audio_markers
    from research_agent.task_tracker import TaskTracker
except ImportError as ie:
    logger.warning(f"research_agent helpers not importable ({ie}); commands and voice replies disabled")
    resolve_command = None
    cmd_help_lines = lambda: []  # noqa: E731
    COMMAND_REGISTRY = ()
    extract_audio_markers = lambda t: (None, False, None, t or "")  # noqa: E731
    TaskTracker = None

# Env config validation
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get("SUPABASE_ANON_KEY", "").strip()
LANGGRAPH_API_URL = os.environ.get("LANGGRAPH_API_URL", "http://localhost:2024").strip()

if not SUPABASE_URL or not SUPABASE_KEY:
    logger.error("SUPABASE_URL and either SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY must be set in .env")
    sys.exit(1)

# Initialize Supabase
try:
    supabase_options = ClientOptions(
        storage_client_timeout=300,
        postgrest_client_timeout=300
    )
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY, options=supabase_options)
    logger.info("Supabase client initialized successfully with 300s timeout options.")
except Exception as e:
    logger.error(f"Failed to initialize Supabase client: {e}")
    sys.exit(1)

# Initialize LangGraph client
try:
    langgraph_client = get_client(url=LANGGRAPH_API_URL)
    logger.info(f"LangGraph client initialized targeting {LANGGRAPH_API_URL}")
except Exception as e:
    logger.error(f"Failed to initialize LangGraph client: {e}")
    sys.exit(1)

# Parse Allowed Users
allowed_str = os.environ.get("TELEGRAM_ALLOWED_USERS", "").strip()
if allowed_str and allowed_str != "*":
    ALLOWED_USERS = {x.strip().lower() for x in allowed_str.split(",") if x.strip()}
    logger.info(f"Access restricted to users: {ALLOWED_USERS}")
else:
    ALLOWED_USERS = None
    logger.info("Access open to all users (TELEGRAM_ALLOWED_USERS is wildcard or empty).")

RESOLVED_ASSISTANT_ID = None


def is_user_allowed(user) -> bool:
    """Check if a Telegram user is allowed to run workflows."""
    if ALLOWED_USERS is None:
        return True
    if not user:
        return False
    user_id = str(user.id)
    username = str(user.username).lower() if user.username else ""
    return (user_id in ALLOWED_USERS) or (username in ALLOWED_USERS)


# ── Supabase Thread Helper ────────────────────────────────────────────────────

async def save_thread_binding(chat_id: int, workflow_id: str, thread_id: str):
    """Save chat → workflow → thread binding to database (for web app visibility)."""
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(
            None,
            lambda: supabase.table("telegram_chat_bindings")
            .upsert({
                "chat_id": str(chat_id),
                "workflow_id": workflow_id,
                "thread_id": thread_id,
                "is_active": True,
                "updated_at": "now()"
            }, on_conflict="chat_id,workflow_id")
            .execute()
        )
        logger.info(f"Saved thread binding: chat={chat_id}, workflow={workflow_id}, thread={thread_id}")
    except Exception as e:
        logger.error(f"Error saving thread binding: {e}")


# ── Table Formatting Helpers ──────────────────────────────────────────────────

def is_separator_line(line: str) -> bool:
    """Check if a line looks like a markdown table separator (e.g. |---|---|)."""
    line_strip = line.strip()
    if not line_strip:
        return False
    if "|" not in line_strip:
        return False
    allowed_chars = set("|-: \t")
    if not set(line_strip).issubset(allowed_chars):
        return False
    if "-" not in line_strip:
        return False
    return True


def _render_ascii_table(header: str, data_lines: list[str]) -> str:
    """Formats a markdown table into an aligned ASCII table wrapped in a monospace block."""
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
    """Detects markdown tables in text and replaces them with aligned ASCII tables."""
    lines = text.split("\n")
    processed_lines = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        if is_separator_line(line):
            if i > 0:
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


def extract_generated_files(text: str) -> list[tuple[str, str]]:
    """Extract generated file URLs and names from text. Returns list of (filename, url)."""
    import re
    files = []
    seen = set()
    
    for m in re.finditer(r'FILE_URL:\s*(https?://[^\s<>"]+)', text):
        url = m.group(1).rstrip(").,;")
        if url not in seen:
            seen.add(url)
            fname = url.split("/")[-1]
            if "_" in fname and len(fname.split("_")[0]) <= 8:
                fname = "_".join(fname.split("_")[1:])
            files.append((fname, url))

    for m in re.finditer(r'\[([^\]]+\.(?:pdf|png|jpg|jpeg|gif|webp|svg|docx|xlsx|pptx|csv|json|py|txt|zip|tar|gz))\]\((https?://[^\s\)]+)\)', text, re.IGNORECASE):
        fname = m.group(1)
        url = m.group(2)
        if url not in seen:
            seen.add(url)
            files.append((fname, url))

    for m in re.finditer(r'(https?://[^\s<>"]+/(?:uploads|terminal)/[^\s<>"]+\.(?:pdf|png|jpg|jpeg|gif|webp|svg|docx|xlsx|pptx|csv|json|py|txt|zip))', text, re.IGNORECASE):
        url = m.group(1).rstrip(").,;")
        if url not in seen:
            seen.add(url)
            fname = url.split("/")[-1]
            if "_" in fname and len(fname.split("_")[0]) <= 8:
                fname = "_".join(fname.split("_")[1:])
            files.append((fname, url))

    return files


def split_message_chunks(text: str, max_length: int = 3900) -> list[str]:
    """Split text into chunks that fit within Telegram's max message length limit."""
    if not text or len(text) <= max_length:
        return [text] if text else []
    
    chunks = []
    current_chunk = []
    current_length = 0
    
    for line in text.split("\n"):
        line_len = len(line) + 1
        if current_length + line_len > max_length:
            if current_chunk:
                chunks.append("\n".join(current_chunk))
                current_chunk = []
                current_length = 0
            if len(line) > max_length:
                for i in range(0, len(line), max_length):
                    chunks.append(line[i:i + max_length])
            else:
                current_chunk.append(line)
                current_length = line_len
        else:
            current_chunk.append(line)
            current_length += line_len
            
    if current_chunk:
        chunks.append("\n".join(current_chunk))
    return chunks


def convert_markdown_to_html(text: str) -> str:
    if not text:
        return ""
    import html
    import re
    
    # 1. Extract code blocks (```...```) to protect them
    code_blocks = []
    def save_code_block(match):
        code_blocks.append(match.group(1))
        return f"PLACEHOLDERCODEBLOCK{len(code_blocks)-1}"
    text = re.sub(r'```(.*?)```', save_code_block, text, flags=re.DOTALL)
    
    # 2. Protect inline code (`...`)
    inline_codes = []
    def save_inline_code(match):
        inline_codes.append(match.group(1))
        return f"PLACEHOLDERINLINECODE{len(inline_codes)-1}"
    text = re.sub(r'`(.*?)`', save_inline_code, text)

    # 3. Protect markdown links [text](url)
    links = []
    def save_link(match):
        link_text = match.group(1)
        link_url = match.group(2)
        links.append((link_text, link_url))
        return f"PLACEHOLDERLINK{len(links)-1}"
    text = re.sub(r'\[(.*?)\]\((https?://[^\s\)]+)\)', save_link, text)

    # 4. Protect raw URLs
    raw_urls = []
    def save_raw_url(match):
        raw_urls.append(match.group(0))
        return f"PLACEHOLDERRAWURL{len(raw_urls)-1}"
    text = re.sub(r'https?://[^\s<>"]+', save_raw_url, text)

    # 5. Protect filenames with underscores (e.g. some_file_name.pdf)
    filenames = []
    def save_filename(match):
        filenames.append(match.group(0))
        return f"PLACEHOLDERFILENAME{len(filenames)-1}"
    text = re.sub(r'\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\.[A-Za-z0-9]+\b', save_filename, text)
    
    # 6. Escape HTML special characters for the rest of the text
    text = html.escape(text)
    
    # 7. Format blockquotes & callouts line-by-line
    lines = text.split("\n")
    formatted_lines = []
    in_quote = False
    quote_content = []
    
    callout_map = {
        "[!info]": "<b>ℹ️ Info:</b>",
        "[!note]": "<b>📝 Note:</b>",
        "[!tip]": "<b>💡 Tip:</b>",
        "[!warning]": "<b>⚠️ Warning:</b>",
        "[!important]": "<b>🚨 Important:</b>",
        "[!caution]": "<b>🛑 Caution:</b>"
    }
    
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("&gt;"):
            if not in_quote:
                in_quote = True
            quote_line = stripped[4:].strip()
            for tag, replacement in callout_map.items():
                escaped_tag = html.escape(tag)
                if quote_line.startswith(escaped_tag):
                    quote_line = quote_line.replace(escaped_tag, replacement, 1)
                    break
            quote_content.append(quote_line)
        else:
            if in_quote:
                formatted_lines.append(f"<blockquote>" + "\n".join(quote_content) + "</blockquote>")
                quote_content = []
                in_quote = False
            header_match = re.match(r'^(#{1,6})\s+(.+)$', line)
            if header_match:
                formatted_lines.append(f"<b>{header_match.group(2).strip()}</b>")
            else:
                formatted_lines.append(line)
            
    if in_quote:
        formatted_lines.append(f"<blockquote>" + "\n".join(quote_content) + "</blockquote>")
        
    text = "\n".join(formatted_lines)
    
    # 8. Bold (**text** or __text__)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'__(.+?)__', r'<b>\1</b>', text)

    # 9. Italics (*text* or _text_)
    text = re.sub(r'(?<!\w)\*([^\*\n]+?)\*(?!\w)', r'<i>\1</i>', text)
    text = re.sub(r'(?<!\w)_([^_\n]+?)_(?!\w)', r'<i>\1</i>', text)

    # 10. Restore filenames
    for i, fname in enumerate(filenames):
        text = text.replace(f"PLACEHOLDERFILENAME{i}", html.escape(fname))

    # 11. Restore raw URLs
    for i, u in enumerate(raw_urls):
        escaped_u = html.escape(u)
        text = text.replace(f"PLACEHOLDERRAWURL{i}", f'<a href="{escaped_u}">{escaped_u}</a>')

    # 12. Restore markdown links
    for i, (link_text, link_url) in enumerate(links):
        escaped_text = html.escape(link_text)
        escaped_url = html.escape(link_url)
        text = text.replace(f"PLACEHOLDERLINK{i}", f'<a href="{escaped_url}">{escaped_text}</a>')
    
    # 13. Restore Protected Code Blocks & Inline Code
    for i, code_content in enumerate(code_blocks):
        escaped_code = html.escape(code_content)
        text = text.replace(f"PLACEHOLDERCODEBLOCK{i}", f"<pre>{escaped_code}</pre>")
        
    for i, code_content in enumerate(inline_codes):
        escaped_code = html.escape(code_content)
        text = text.replace(f"PLACEHOLDERINLINECODE{i}", f"<code>{escaped_code}</code>")
        
    return text


def format_agent_response(text: str) -> str:
    if not text:
        return ""
    tables_formatted = format_markdown_tables(text)
    return convert_markdown_to_html(tables_formatted)


# ── Telegram Bot Instance Wrapper ─────────────────────────────────────────────

class TelegramBotInstance:
    """
    Manages one Telegram Bot connection that routes to ALL enabled workflows.
    
    Session flow per chat:
      /start       → Shows inline keyboard of all workflows
      Tap workflow → Creates a NEW LangGraph thread for that workflow
      Messages     → Routed to the currently active (workflow_id, thread_id) session
      /start again → Same keyboard; tapping any workflow starts a fresh thread
    """

    def __init__(self, bot_id: str, token: str, user_id: str):
        self.bot_id = bot_id
        self.token = token
        self.user_id = user_id
        self.application = None
        # Per-chat active session: chat_id (int) -> {workflow_id, workflow_name, thread_id}
        self.active_sessions: dict[int, dict] = {}
        # Per-chat voice reply mode: "off" | "voice_only" | "all" (persisted in telegram_chat_bindings)
        self.voice_modes: dict[int, str] = {}
        # Per-chat pending tool/command edit (chat_id -> {"thread_id": ..., "tool_name": ..., "status_message_id": ...})
        self.pending_tool_edits: dict[int, dict] = {}
        self.pending_terminal_edits = self.pending_tool_edits

    async def get_voice_mode(self, chat_id: int) -> str:
        """Voice reply mode for this chat (cached, falls back to Supabase binding)."""
        if chat_id in self.voice_modes:
            return self.voice_modes[chat_id]
        mode = "voice_only"
        loop = asyncio.get_running_loop()
        try:
            resp = await loop.run_in_executor(
                None,
                lambda: supabase.table("telegram_chat_bindings")
                .select("voice_mode")
                .eq("chat_id", str(chat_id))
                .order("updated_at", desc=True)
                .limit(1)
                .execute()
            )
            if resp.data and resp.data[0].get("voice_mode"):
                mode = resp.data[0]["voice_mode"]
        except Exception as e:
            logger.warning(f"Failed to load voice_mode for chat {chat_id}: {e}")
        self.voice_modes[chat_id] = mode
        return mode

    async def save_voice_mode(self, chat_id: int, mode: str):
        """Persist this chat's voice reply mode (off | voice_only | all)."""
        self.voice_modes[chat_id] = mode
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(
                None,
                lambda: supabase.table("telegram_chat_bindings")
                .update({"voice_mode": mode, "updated_at": "now()"})
                .eq("chat_id", str(chat_id))
                .execute()
            )
        except Exception as e:
            logger.warning(f"Failed to persist voice_mode for chat {chat_id}: {e}")

    async def get_enabled_workflows(self) -> list[dict]:
        """Fetch all workflows from Supabase."""
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
            logger.error(f"Error fetching workflows: {e}")
            return []

    async def start(self):
        """Build and asynchronously run the bot polling."""
        from telegram.request import HTTPXRequest
        request_obj = HTTPXRequest(connect_timeout=300.0, read_timeout=300.0, write_timeout=300.0)
        builder = Application.builder().token(self.token).request(request_obj)

        telegram_proxy = os.environ.get("TELEGRAM_PROXY", "").strip()
        if telegram_proxy:
            builder.proxy(telegram_proxy)

        self.application = builder.build()

        # Register handlers
        self.application.add_handler(CommandHandler("start", self.start_command))
        self.application.add_handler(CommandHandler("status", self.status_command))
        self.application.add_handler(CommandHandler("workflows", self.start_command))  # alias
        self.application.add_handler(CommandHandler("stop", self.stop_command))
        self.application.add_handler(CommandHandler("cancel", self.stop_command))
        self.application.add_handler(CommandHandler("new", self.new_command))
        self.application.add_handler(CommandHandler("voice", self.voice_command))
        self.application.add_handler(CommandHandler("help", self.help_command))
        self.application.add_handler(CallbackQueryHandler(self.handle_workflow_selection, pattern=r"^select_wf:"))
        self.application.add_handler(CallbackQueryHandler(self.handle_tool_approval, pattern=r"^(term|tool)_(ok|no|edit|always):"))
        self.application.add_handler(MessageHandler(
            (filters.TEXT | filters.PHOTO | filters.VOICE | filters.AUDIO | filters.VIDEO | filters.Document.ALL) & ~filters.COMMAND,
            self.handle_message
        ))

        await self.application.initialize()
        await self.application.start()

        # Sync native Telegram bot commands for popover autocomplete
        try:
            bot_cmds = [
                BotCommand("start", "Select or switch the active workflow"),
                BotCommand("new", "Start a new conversation thread"),
                BotCommand("stop", "Stop active agent execution"),
                BotCommand("status", "Show the active workflow and thread"),
                BotCommand("voice", "Configure voice replies (on/off/tts)"),
                BotCommand("learn", "Learn a reusable skill from description"),
                BotCommand("help", "List available commands"),
            ]
            await self.application.bot.set_my_commands(bot_cmds)
            logger.info(f"Bot {self.bot_id[:8]} synced {len(bot_cmds)} commands with Telegram.")
        except Exception as ce:
            logger.warning(f"Failed to sync Telegram bot commands: {ce}")

        await self.application.updater.start_polling()
        logger.info(f"Bot {self.bot_id[:8]} started — multi-workflow mode ready.")


    async def stop(self):
        """Gracefully stop the polling loop and release resources."""
        if self.application:
            try:
                await self.application.updater.stop()
                await self.application.stop()
                await self.application.shutdown()
            except Exception as e:
                logger.warning(f"Error stopping bot {self.bot_id[:8]}: {e}")
            logger.info(f"Bot {self.bot_id[:8]} terminated.")

    # ── Commands ─────────────────────────────────────────────────────────────

    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Show all enabled workflows as inline keyboard buttons."""
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        workflows = await self.get_enabled_workflows()

        if not workflows:
            await update.message.reply_text(
                "❌ No active workflows found.\n\n"
                "Please create and enable workflows in the app first."
            )
            return

        keyboard = [
            [InlineKeyboardButton(f"🤖  {wf['name']}", callback_data=f"select_wf:{wf['id']}:{wf['name']}")]
            for wf in workflows
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)

        chat_id = update.effective_chat.id
        current_session = self.active_sessions.get(chat_id)

        if current_session:
            header = (
                f"🔄 *Switch Workflow*\n\n"
                f"Currently active: *{current_session['workflow_name']}*\n\n"
                "Select a workflow below to start a *new conversation*:"
            )
        else:
            header = (
                "👋 *Welcome to Deep Agents!*\n\n"
                "Select a workflow to start a new conversation:"
            )

        await update.message.reply_text(header, parse_mode="Markdown", reply_markup=reply_markup)

    async def status_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Show current active workflow and thread info."""
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        chat_id = update.effective_chat.id
        session = self.active_sessions.get(chat_id)

        if session:
            msg = (
                "📌 *Current Status*\n\n"
                f"🤖 *Workflow:* `{session['workflow_name']}`\n"
                f"🧵 *Thread ID:* `{session['thread_id']}`\n\n"
                "Use /start to switch to a different workflow (creates a new thread)."
            )
        else:
            msg = (
                "📌 *Current Status*\n\n"
                "❌ No active session. Use /start to select a workflow."
            )

        await update.message.reply_text(msg, parse_mode="Markdown")

    # ── Callback: Workflow Selection ──────────────────────────────────────────

    async def handle_workflow_selection(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        Handles inline button tap. Creates a new LangGraph thread for the selected workflow
        and sets it as the active session for this chat.
        """
        query = update.callback_query
        await query.answer()

        if not is_user_allowed(query.from_user):
            await query.edit_message_text("⛔ Access denied.")
            return

        # Parse callback data: "select_wf:{workflow_id}:{workflow_name}"
        parts = query.data.split(":", 2)
        if len(parts) != 3:
            await query.edit_message_text("❌ Invalid selection. Try /start again.")
            return

        _, workflow_id, workflow_name = parts
        chat_id = query.message.chat_id

        # Show "creating" feedback immediately
        await query.edit_message_text(
            f"⏳ Starting a new conversation with *{workflow_name}*...",
            parse_mode="Markdown"
        )

        # Resolve assistant ID once
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

        # Create a new LangGraph thread
        try:
            thread = await langgraph_client.threads.create(
                metadata={
                    "workflow_id": workflow_id,
                    "user_id": self.user_id,
                    "telegram_chat_id": str(chat_id)
                }
            )
            thread_id = thread["thread_id"]
        except Exception as e:
            logger.error(f"Failed to create LangGraph thread: {e}")
            await query.edit_message_text(
                f"❌ Failed to create conversation thread.\n\n`{e}`",
                parse_mode="Markdown"
            )
            return

        # Store active session in memory
        self.active_sessions[chat_id] = {
            "workflow_id": workflow_id,
            "workflow_name": workflow_name,
            "thread_id": thread_id
        }

        # Persist to Supabase for web app thread visibility
        await save_thread_binding(chat_id, workflow_id, thread_id)

        await query.edit_message_text(
            f"✅ *{workflow_name}* is ready!\n\n"
            f"🧵 Thread: `{thread_id}`\n\n"
            "Send your first message below.\n"
            "Use /start to switch workflows (creates a fresh thread).",
            parse_mode="Markdown"
        )

    # ── Slash commands (/stop, /new, /voice, /help, /status) ────────────────────

    async def stop_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Stop and cancel any active streaming run for this chat."""
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        chat_id = update.effective_chat.id
        cancelled = False
        if TaskTracker:
            cancelled = await TaskTracker.cancel_run(str(chat_id))

        if cancelled:
            await update.message.reply_text("🛑 *Active execution stopped.*", parse_mode="Markdown")
        else:
            await update.message.reply_text("ℹ️ No active agent task is currently running.", parse_mode="Markdown")

    async def new_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Start a new conversation thread with the active workflow."""
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        chat_id = update.effective_chat.id
        session = self.active_sessions.get(chat_id)
        if not session:
            await update.message.reply_text("No active workflow yet — use /start to pick one first.")
            return

        try:
            thread = await langgraph_client.threads.create(
                metadata={
                    "workflow_id": session["workflow_id"],
                    "user_id": self.user_id,
                    "telegram_chat_id": str(chat_id)
                }
            )
            session["thread_id"] = thread["thread_id"]
            await save_thread_binding(chat_id, session["workflow_id"], thread["thread_id"])
            await update.message.reply_text(f"🆕 Fresh conversation started with *{session['workflow_name']}*.", parse_mode="Markdown")
        except Exception as e:
            await update.message.reply_text(f"❌ Couldn't start a new thread: {e}")

    async def voice_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Configure voice reply mode (/voice on, /voice tts, /voice off)."""
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        chat_id = update.effective_chat.id
        args = context.args or []
        arg_str = args[0] if args else ""
        await self._execute_voice_mode(update, chat_id, arg_str)

    async def _execute_voice_mode(self, update: Update, chat_id: int, args: str) -> bool:
        mapping = {"on": "voice_only", "off": "off", "tts": "all"}
        mode = mapping.get(args.lower().strip())
        if not mode:
            await update.message.reply_text(
                "Usage:\n"
                "• `/voice on` — speak replies to your voice messages 🎙️\n"
                "• `/voice tts` — speak every reply 🔊\n"
                "• `/voice off` — text only 💬",
                parse_mode="Markdown"
            )
            return True
        await self.save_voice_mode(chat_id, mode)
        label = {
            "voice_only": "ON — I'll speak replies to your voice messages 🎙️",
            "off": "OFF — text only 💬",
            "all": "TTS — I'll speak every reply 🔊",
        }[mode]
        await update.message.reply_text(f"Voice replies: *{label}*", parse_mode="Markdown")
        return True

    async def help_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Show available commands."""
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        lines = cmd_help_lines() if cmd_help_lines else []
        cmd_text = "\n".join(lines) if lines else "/start, /new, /stop, /status, /voice, /learn, /help"
        await update.message.reply_text(
            f"🤖 *Available Commands*\n\n{cmd_text}\n\n"
            "Interactive buttons: Use the approval buttons for command approvals.",
            parse_mode="Markdown"
        )

    async def handle_slash_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE, text: str) -> bool:
        """Handle /- and !-prefixed session commands. Returns True when fully handled."""
        if resolve_command is None:
            return True
        parsed = resolve_command(text)
        chat_id = update.effective_chat.id
        if not parsed:
            await update.message.reply_text("❓ Unknown command. Try `/help`", parse_mode="Markdown")
            return True
        cmd, args = parsed

        if cmd.kind == "agent":
            return False  # e.g. /learn — the agent graph preprocess node handles it

        if cmd.name in ("stop", "cancel", "abort"):
            await self.stop_command(update, context)
            return True

        if cmd.name == "voice":
            await self._execute_voice_mode(update, chat_id, args)
            return True

        if cmd.name == "help":
            await self.help_command(update, context)
            return True

        if cmd.name == "status":
            await self.status_command(update, context)
            return True

        if cmd.name == "new":
            await self.new_command(update, context)
            return True

        if cmd.name in ("start", "workflows"):
            await self.start_command(update, context)
            return True

        await update.message.reply_text("❓ Unknown command. Try `/help`", parse_mode="Markdown")
        return True

    handle_bang_command = handle_slash_command


    # ── Terminal command approval (human-in-the-loop) ──────────────────────────

    async def _pending_interrupt(self, thread_id: str) -> dict | None:
        """Return the pending HITL interrupt payload (e.g. tool/terminal approval), if any."""
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

    async def _send_approval_prompt(self, bot, chat_id: int, thread_id: str, payload: dict):
        """Universal Tool Approval card for Telegram with argument truncation, Always-Allow, and Edit."""
        import html as _html
        import json as _json
        reqs = payload.get("action_requests") or payload.get("actionRequests") or []
        if not reqs and (payload.get("name") or payload.get("tool_name")):
            reqs = [payload]
        req = reqs[0] if reqs else {}
        req_count = max(1, len(reqs))
        tool_name = req.get("name") or req.get("tool_name") or "tool"
        args = req.get("args") or req.get("arguments") or {}
        desc = req.get("description") or f"Tool '{tool_name}' requires human approval before running."

        # Cache approval info for this thread
        if not hasattr(self, "pending_tool_approvals"):
            self.pending_tool_approvals = {}
        self.pending_tool_approvals[thread_id] = {
            "tool_name": tool_name,
            "args": args,
            "desc": desc,
            "req_count": req_count,
        }

        # Format arguments with safe truncation so message never exceeds Telegram 4096 char limit
        args_lines = []
        if isinstance(args, dict) and args:
            for k, v in args.items():
                if isinstance(v, str):
                    if len(v) > 150:
                        val_str = _html.escape(v[:150]) + f"… <i>({len(v)} chars)</i>"
                    else:
                        val_str = _html.escape(v)
                elif isinstance(v, (int, float, bool)):
                    val_str = str(v)
                else:
                    dumped = _json.dumps(v)
                    if len(dumped) > 150:
                        val_str = _html.escape(dumped[:150]) + f"… <i>({len(dumped)} chars)</i>"
                    else:
                        val_str = _html.escape(dumped)
                args_lines.append(f"• <b>{_html.escape(str(k))}</b>: <code>{val_str}</code>")
            formatted_args = "\n".join(args_lines)
        else:
            dumped = str(args)
            if len(dumped) > 200:
                dumped = _html.escape(dumped[:200]) + f"… <i>({len(dumped)} chars)</i>"
            else:
                dumped = _html.escape(dumped)
            formatted_args = f"<code>{dumped}</code>"

        is_batch = len(reqs) > 1

        # Note: Telegram callback_data MUST be <= 64 bytes!
        # "tool_alw:<36-char-uuid>" = 45 bytes (valid).
        keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton("✅ Allow", callback_data=f"tool_ok:{thread_id}"),
                InlineKeyboardButton("❌ Deny", callback_data=f"tool_no:{thread_id}"),
            ],
            [
                InlineKeyboardButton(f"🔓 Always Allow {tool_name[:18]}", callback_data=f"tool_alw:{thread_id}"),
            ],
            [
                InlineKeyboardButton("✏️ Edit Arguments", callback_data=f"tool_edt:{thread_id}"),
            ],
        ])

        header = "🛡️ <b>Tool Execution Permission Required</b>"
        if is_batch:
            header += f" <i>({len(reqs)} calls)</i>"

        text = (
            f"{header}\n\n"
            f"🔧 <b>Tool:</b> <code>{_html.escape(tool_name)}</code>\n"
            f"📝 <b>Details:</b> {_html.escape(desc)}\n\n"
            f"📋 <b>Arguments:</b>\n{formatted_args}"
        )
        if len(text) > 3500:
            text = text[:3400] + "\n\n… <i>(truncated)</i>"

        try:
            await bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode="HTML",
                reply_markup=keyboard,
            )
        except Exception as e:
            logger.warning(f"HTML approval send failed: {e}. Retrying with plain text.")
            plain_args = _json.dumps(args, default=str)
            if len(plain_args) > 500:
                plain_args = plain_args[:500] + f"… ({len(plain_args)} chars)"
            plain_text = f"🛡️ Tool Approval Required: {tool_name}\n\n{desc}\n\nArguments:\n{plain_args}"
            try:
                await bot.send_message(
                    chat_id=chat_id,
                    text=plain_text[:3500],
                    reply_markup=keyboard,
                )
            except Exception as e2:
                logger.error(f"Failed to send plain text approval prompt: {e2}")

    async def _persist_always_allow(self, tool_name: str):
        """Persist permission_mode='always_allow' for a tool in Supabase & Redis."""
        import json as _json
        try:
            url = os.environ.get("SUPABASE_URL", "").rstrip("/")
            key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
            if not url or not key:
                return
            client = create_client(url, key)

            # Check if MCP tool
            mcp_res = client.table("mcp_tool_settings").select("id").eq("tool_key", tool_name).execute()
            if mcp_res.data and len(mcp_res.data) > 0:
                client.table("mcp_tool_settings").update({
                    "permission_mode": "always_allow",
                    "updated_at": "now()"
                }).eq("tool_key", tool_name).execute()
                perm_key = "mcp_tools_permission_modes"
            else:
                perm_key = "builtin_tools_permission_modes"

            query = client.table("agent_settings").select("value").eq("key", perm_key)
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
            client.table("agent_settings").upsert(upsert_payload, on_conflict="key,user_id").execute()
            logger.info(f"Persisted 'always_allow' for tool '{tool_name}' (user: {self.user_id})")
        except Exception as e:
            logger.warning(f"Failed to persist always_allow for '{tool_name}': {e}")

    async def handle_tool_approval(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Inline-keyboard callback for tool & terminal command approvals."""
        query = update.callback_query
        await query.answer()
        if not is_user_allowed(query.from_user):
            await query.edit_message_text("⛔ Access denied.")
            return

        parts = query.data.split(":")
        kind = parts[0]  # tool_ok, tool_no, tool_alw, tool_always, tool_edt, tool_edit, term_ok, term_no, term_edit
        thread_id = parts[1] if len(parts) > 1 else ""
        
        # Look up cached tool name and batch request count
        cached_info = getattr(self, "pending_tool_approvals", {}).get(thread_id, {})
        tool_name = parts[2] if len(parts) > 2 else cached_info.get("tool_name", "tool")
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
        chat_id = query.message.chat_id

        # Only the chat that owns the pending interruption may decide
        session = self.active_sessions.get(chat_id)
        if session and session.get("thread_id") != thread_id:
            await query.answer("This approval belongs to a different thread.", show_alert=True)
            return

        base_text = query.message.text_html or ""

        if kind in ("tool_edt", "tool_edit", "term_edit"):
            self.pending_tool_edits[chat_id] = {
                "thread_id": thread_id,
                "tool_name": tool_name,
                "status_message_id": query.message.message_id,
            }
            try:
                await query.edit_message_text(
                    base_text + "\n\n✏️ <i>Reply with updated argument value or JSON:</i>",
                    parse_mode="HTML"
                )
            except Exception:
                pass
            return

        if kind in ("tool_alw", "tool_always"):
            try:
                await self._persist_always_allow(tool_name)
                await query.edit_message_text(
                    base_text + f"\n\n🔓 <i>Always Allowed for <b>{tool_name}</b> — executing…</i>",
                    parse_mode="HTML"
                )
            except Exception as pe:
                logger.warning(f"Failed to update message on always allow: {pe}")
            await self._resume_and_continue(
                context.bot, chat_id, thread_id,
                {"decisions": [{"type": "approve"} for _ in range(req_count)]},
                status_message_id=query.message.message_id,
            )
            return

        if kind in ("tool_ok", "term_ok"):
            try:
                await query.edit_message_text(base_text + "\n\n✅ <i>Allowed — executing…</i>", parse_mode="HTML")
            except Exception:
                pass
            await self._resume_and_continue(
                context.bot, chat_id, thread_id,
                {"decisions": [{"type": "approve"} for _ in range(req_count)]},
                status_message_id=query.message.message_id,
            )
        else:  # tool_no, term_no
            try:
                await query.edit_message_text(base_text + "\n\n❌ <i>Denied — the agent has been told.</i>", parse_mode="HTML")
            except Exception:
                pass
            await self._resume_and_continue(
                context.bot, chat_id, thread_id,
                {"decisions": [{"type": "reject", "message": "User denied tool execution via Telegram."} for _ in range(req_count)]},
                status_message_id=query.message.message_id,
            )


    handle_terminal_approval = handle_tool_approval  # backwards compatibility alias


    async def _safe_edit_preview(
        self, bot, chat_id: int, message_id: int | None, text: str,
        edit_state: dict
    ) -> bool:
        """Rate-limit-safe message preview updater during streaming.
        
        Guarantees minimum 2.0s delay between edits, avoids duplicate edits,
        and applies backoff on Telegram 429 rate limits or errors.
        """
        if message_id is None:
            return False

        now = time.time()
        last_time = edit_state.get("time", 0.0)
        last_text = edit_state.get("text", "")

        # Throttle: at least 2.0s between calls
        if now - last_time < 2.0:
            return False

        trimmed = text.strip()
        if not trimmed or trimmed == last_text:
            return False

        # Set optimistic state immediately so fast incoming chunks don't trigger simultaneous edits
        edit_state["time"] = now
        edit_state["text"] = trimmed

        try:
            preview_text = extract_audio_markers(trimmed)[-1]
            await bot.edit_message_text(
                text=preview_text[:3900] + " ▉",
                chat_id=chat_id,
                message_id=message_id
            )
            return True
        except Exception as e:
            err_str = str(e).lower()
            if "retry_after" in err_str or "too many requests" in err_str or "429" in err_str:
                # Add backoff delay on 429 so we don't hammer Telegram
                edit_state["time"] = now + 4.0
            elif "not modified" in err_str:
                edit_state["time"] = now
            else:
                edit_state["time"] = now + 2.0
            return False

    async def _resume_and_continue(self, bot, chat_id: int, thread_id: str, resume_payload: dict, status_message_id: int | None = None):
        """Resume an interrupted run and process the continuation (same tail as a normal run)."""
        session = self.active_sessions.get(chat_id)
        config = {
            "configurable": {
                "workflow_id": session["workflow_id"] if session else None,
                "user_id": self.user_id,
                "platform": "telegram",
                "voice_mode": await self.get_voice_mode(chat_id),
                "voice_input": False,
            }
        }
        accumulated_text = ""
        active_messages: dict = {}
        edit_state = {"time": 0.0, "text": ""}
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
                    if accumulated_text.strip() and status_message_id is not None:
                        await self._safe_edit_preview(bot, chat_id, status_message_id, accumulated_text, edit_state)
        except Exception as e:
            logger.exception("Error resuming run after approval decision")
            await bot.send_message(chat_id=chat_id, text=f"❌ Failed to resume: {e}")
            return

        await self._finish_run(bot, chat_id, thread_id, accumulated_text, status_message_id)

    async def _finish_run(self, bot, chat_id: int, thread_id: str, streamed_text: str, status_message_id: int | None):
        """Tail of every run: pause for approval if interrupted, deliver final
        formatted text (with auto-chunking), send generated documents/files, plus voice reply."""
        # 1. Pending human approval? (terminal tool interrupt)
        pending = await self._pending_interrupt(thread_id)
        if pending:
            if status_message_id is not None:
                try:
                    await bot.edit_message_text(
                        text="⏸️ Agent paused — needs your approval:",
                        chat_id=chat_id,
                        message_id=status_message_id
                    )
                except Exception:
                    pass
            await self._send_approval_prompt(bot, chat_id, thread_id, pending)
            return

        # 2. Final text and files from thread state (latest turn only)
        audio_url, is_voice, final_text = None, False, streamed_text
        state = None
        voice_mode = await self.get_voice_mode(chat_id)
        is_voice_expected = (voice_mode in ("all", "tts", "on"))

        max_attempts = 3 if is_voice_expected else 1
        for _attempt in range(max_attempts):
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

                if audio_url or not is_voice_expected:
                    break
            except Exception as e:
                logger.warning(f"Final state fetch attempt failed: {e}")
            if _attempt < max_attempts - 1:
                await asyncio.sleep(1.0)

        if audio_url is None and streamed_text:
            audio_url, is_voice, _provider, cleaned = extract_audio_markers(streamed_text)
            if audio_url:
                final_text = cleaned

        # 3. Extract generated files (.pdf, images, docs, data sheets) from current turn
        all_thread_text = final_text
        try:
            if isinstance(state, dict):
                msgs = (state.get("values", {}) or {}).get("messages", [])
                turn_chunks = []
                for m in reversed(msgs):
                    role = m.get("type") or m.get("role")
                    c = m.get("content", "")
                    if isinstance(c, list):
                        turn_chunks.append(" ".join((b.get("text", "") if isinstance(b, dict) else str(b)) for b in c))
                    elif isinstance(c, str):
                        turn_chunks.append(c)
                    if role in ("user", "human"):
                        break
                all_thread_text = " ".join(reversed(turn_chunks))
        except Exception:
            all_thread_text = final_text

        generated_files = extract_generated_files(all_thread_text or final_text)

        # 4. Edit status placeholder with formatted final response & send extra chunks if long
        if status_message_id is not None:
            if final_text.strip():
                formatted_response = format_agent_response(final_text)
                chunks = split_message_chunks(formatted_response, max_length=3900)
                first_chunk = chunks[0] if chunks else formatted_response

                try:
                    await bot.edit_message_text(
                        text=first_chunk,
                        chat_id=chat_id,
                        message_id=status_message_id,
                        parse_mode="HTML"
                    )
                except Exception as e:
                    logger.warning(f"Telegram HTML send failed: {e}. Retrying with plain text chunks.")
                    plain_chunks = split_message_chunks(final_text, max_length=3900)
                    chunks = plain_chunks
                    try:
                        await bot.edit_message_text(
                            text=chunks[0] if chunks else final_text[:3900],
                            chat_id=chat_id,
                            message_id=status_message_id
                        )
                    except Exception as e2:
                        logger.error(f"Plain message edit failed: {e2}")

                # Send overflow message chunks if response exceeds Telegram single message limit
                for extra_chunk in chunks[1:]:
                    try:
                        await bot.send_message(
                            chat_id=chat_id,
                            text=extra_chunk,
                            parse_mode="HTML"
                        )
                    except Exception:
                        try:
                            await bot.send_message(
                                chat_id=chat_id,
                                text=extra_chunk
                            )
                        except Exception as send_err:
                            logger.error(f"Failed to send extra message chunk: {send_err}")
            else:
                try:
                    await bot.edit_message_text(
                        text="🤖 Done. (No response content was generated.)",
                        chat_id=chat_id,
                        message_id=status_message_id
                    )
                except Exception:
                    pass

        # 5. Deliver generated file attachments (PDFs, images, data sheets)
        for fname, file_url in generated_files:
            try:
                lower_fname = fname.lower()
                if lower_fname.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
                    logger.info(f"Delivering generated photo {fname} to Telegram chat {chat_id}")
                    await bot.send_photo(chat_id=chat_id, photo=file_url, caption=f"🖼️ {fname}")
                else:
                    logger.info(f"Delivering generated document {fname} to Telegram chat {chat_id}")
                    await bot.send_document(chat_id=chat_id, document=file_url, filename=fname, caption=f"📄 {fname}")
            except Exception as file_err:
                logger.warning(f"Failed to deliver generated file {fname} directly via Telegram: {file_err}")

        # 6. Deliver the audio reply (native voice bubble first, fallback to audio file)
        if audio_url:
            try:
                await bot.send_voice(chat_id=chat_id, voice=audio_url)
            except Exception as ve:
                logger.info(f"send_voice failed ({ve}), falling back to send_audio...")
                try:
                    await bot.send_audio(chat_id=chat_id, audio=audio_url)
                except Exception as ae:
                    logger.error(f"Failed to deliver audio reply: {ae}")

    # ── Message Handler ───────────────────────────────────────────────────────

    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Route user message to the currently active workflow thread."""
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        chat_id = update.effective_chat.id
        user_text = update.message.text or update.message.caption or ""
        session = self.active_sessions.get(chat_id)

        # Pending tool/terminal-command edit: the next text message replaces the argument/command
        if chat_id in self.pending_tool_edits and user_text.strip() and not user_text.strip().startswith(("/", "!")):
            state = self.pending_tool_edits.pop(chat_id)
            tool_name = state.get("tool_name", "terminal")
            thread_id = state["thread_id"]
            
            # Parse user input as JSON or raw string
            raw_input = user_text.strip()
            try:
                import json as _json
                if raw_input.startswith("{") and raw_input.endswith("}"):
                    edited_args = _json.loads(raw_input)
                elif tool_name == "terminal":
                    edited_args = {"command": raw_input}
                else:
                    edited_args = {"input": raw_input}
            except Exception:
                edited_args = {"command": raw_input} if tool_name == "terminal" else {"input": raw_input}
            
            await self._resume_and_continue(
                context.bot, chat_id, thread_id,
                {"decisions": [{"type": "edit", "edited_action": {"name": tool_name, "args": edited_args}}]},
                status_message_id=state.get("status_message_id"),
            )
            return

        # Slash and bang commands (/stop, /status, /voice, /new, /start, /help)
        # Agent commands (/learn …) fall through to the agent graph preprocess node.
        if user_text.strip().startswith(("/", "!")):
            handled = await self.handle_slash_command(update, context, user_text.strip())
            if handled:
                return


        if not session:
            # No workflow selected yet — prompt to pick one
            workflows = await self.get_enabled_workflows()
            if not workflows:
                await update.message.reply_text(
                    "❌ No active workflows found. Please create workflows in the app first."
                )
                return

            keyboard = [
                [InlineKeyboardButton(f"🤖  {wf['name']}", callback_data=f"select_wf:{wf['id']}:{wf['name']}")]
                for wf in workflows
            ]
            reply_markup = InlineKeyboardMarkup(keyboard)
            await update.message.reply_text(
                "👋 Please select a workflow first:",
                reply_markup=reply_markup
            )
            return

        workflow_id = session["workflow_id"]
        workflow_name = session["workflow_name"]
        thread_id = session["thread_id"]

        # Send "thinking" placeholder
        status_message = await update.message.reply_text(
            f"🤖 _[{workflow_name}] Thinking..._", parse_mode="Markdown"
        )
        await context.bot.send_chat_action(chat_id=chat_id, action="typing")

        # Handle file downloads and uploads to Supabase
        attachments = []
        tg_file = None
        mimetype = ""
        filename = "file"
        
        if update.message.photo:
            tg_file = await update.message.photo[-1].get_file(read_timeout=300, write_timeout=300, connect_timeout=300)
            mimetype = "image/jpeg"
            filename = "photo.jpg"
        elif update.message.voice:
            tg_file = await update.message.voice.get_file(read_timeout=300, write_timeout=300, connect_timeout=300)
            mimetype = update.message.voice.mime_type or "audio/ogg"
            filename = "voice.ogg"
        elif update.message.audio:
            tg_file = await update.message.audio.get_file(read_timeout=300, write_timeout=300, connect_timeout=300)
            mimetype = update.message.audio.mime_type or "audio/mpeg"
            filename = update.message.audio.file_name or "audio.mp3"
        elif update.message.video:
            tg_file = await update.message.video.get_file(read_timeout=300, write_timeout=300, connect_timeout=300)
            mimetype = update.message.video.mime_type or "video/mp4"
            filename = update.message.video.file_name or "video.mp4"
        elif update.message.document:
            tg_file = await update.message.document.get_file(read_timeout=300, write_timeout=300, connect_timeout=300)
            mimetype = update.message.document.mime_type or "application/octet-stream"
            filename = update.message.document.file_name or "document"
            
        if tg_file:
            try:
                logger.info(f"Downloading file {filename} from Telegram...")
                file_bytes = await tg_file.download_as_bytearray(read_timeout=300, write_timeout=300, connect_timeout=300)
                file_bytes = bytes(file_bytes)
                logger.info(f"Downloaded {len(file_bytes)} bytes.")

                # Upload to unified storage (R2-first, Supabase fallback)
                from research_agent import storage_service

                logger.info(f"Uploading file {filename} to unified storage...")
                loop = asyncio.get_running_loop()
                file_url = await loop.run_in_executor(
                    None,
                    lambda: storage_service.upload_file(
                        data=file_bytes,
                        filename=filename,
                        mime_type=mimetype,
                        category="uploads",
                        thread_id=thread_id,
                        user_id=self.user_id,
                    )
                )
                if not file_url:
                    raise RuntimeError("storage upload returned no URL (check R2/Supabase configuration)")
                logger.info(f"Uploaded to storage: {file_url}")
                
                # Map to correct attachment dictionary
                lower_name = filename.lower()
                if mimetype.startswith("image/") or lower_name.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
                    attachments.append({
                        "type": "image_url",
                        "image_url": {"url": file_url},
                        "filename": filename
                    })
                elif mimetype.startswith("audio/") or lower_name.endswith((".mp3", ".wav", ".ogg", ".m4a", ".aac")):
                    attachments.append({
                        "type": "audio",
                        "audio": file_url,
                        "filename": filename,
                        "mimeType": mimetype
                    })
                elif mimetype.startswith("video/") or lower_name.endswith((".mp4", ".webm", ".mov", ".avi")):
                    attachments.append({
                        "type": "video",
                        "video": file_url,
                        "filename": filename,
                        "mimeType": mimetype
                    })
                else:
                    attachments.append({
                        "type": "file",
                        "data": file_url,
                        "filename": filename,
                        "mimeType": mimetype
                    })
            except Exception as upload_err:
                logger.error(f"Error handling Telegram attachment {filename}: {upload_err}")
                await update.message.reply_text(f"⚠️ Failed to process file attachment `{filename}`: {upload_err}")

        # Verify thread still exists in LangGraph (recreate if missing)
        try:
            await langgraph_client.threads.get(thread_id)
        except Exception as te:
            if "not found" in str(te).lower():
                logger.info(f"Thread {thread_id} not found in LangGraph, recreating...")
                try:
                    thread = await langgraph_client.threads.create(
                        metadata={
                            "workflow_id": workflow_id,
                            "user_id": self.user_id,
                            "telegram_chat_id": str(chat_id)
                        }
                    )
                    thread_id = thread["thread_id"]
                    self.active_sessions[chat_id]["thread_id"] = thread_id
                    await save_thread_binding(chat_id, workflow_id, thread_id)
                except Exception as ce:
                    logger.error(f"Failed to recreate thread: {ce}")

        if attachments:
            content_list = []
            if user_text:
                content_list.append({"type": "text", "text": user_text})
            for att in attachments:
                content_list.append(att)
            input_data = {"messages": [{"role": "user", "content": content_list}]}
        else:
            input_data = {"messages": [{"role": "user", "content": user_text}]}
        config = {
            "configurable": {
                "workflow_id": workflow_id,
                "user_id": self.user_id,
                "platform": "telegram",
                "voice_mode": await self.get_voice_mode(chat_id),
                "voice_input": bool(update.message.voice or update.message.audio),
            }
        }

        accumulated_text = ""
        edit_state = {"time": 0.0, "text": ""}
        active_messages = {}

        current_task = asyncio.current_task()
        if TaskTracker and current_task:
            await TaskTracker.register_run(str(chat_id), current_task, client=langgraph_client, thread_id=thread_id)

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

                    if event_type == "messages/partial":
                        for msg in data:
                            msg_id = msg.get("id") if isinstance(msg, dict) else getattr(msg, "id", None)
                            content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                            if msg_id and content:
                                active_messages[msg_id] = content
                        
                        accumulated_text = "".join(active_messages.values())
                        if accumulated_text.strip() and status_message:
                            await self._safe_edit_preview(context.bot, chat_id, status_message.message_id, accumulated_text, edit_state)
            except Exception as stream_err:
                from langgraph_sdk.errors import NotFoundError
                if isinstance(stream_err, NotFoundError) or "not found" in str(stream_err).lower():
                    logger.warning("Thread not found on LangGraph. Creating a new thread and retrying...")
                    new_thread = await langgraph_client.threads.create(
                        metadata={
                            "workflow_id": workflow_id,
                            "user_id": self.user_id,
                            "telegram_chat_id": chat_id
                        }
                    )
                    thread_id = new_thread["thread_id"]
                    session["thread_id"] = thread_id
                    
                    # Update binding in DB
                    supabase.table("telegram_thread_bindings").upsert({
                        "chat_id": chat_id,
                        "workflow_id": workflow_id,
                        "thread_id": thread_id,
                        "updated_at": "now()"
                    }, on_conflict="chat_id").execute()
                    
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

                        if event_type == "messages/partial":
                            for msg in data:
                                msg_id = msg.get("id") if isinstance(msg, dict) else getattr(msg, "id", None)
                                content = msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")
                                if msg_id and content:
                                    active_messages[msg_id] = content
                            
                            accumulated_text = "".join(active_messages.values())
                            if accumulated_text.strip() and status_message:
                                await self._safe_edit_preview(context.bot, chat_id, status_message.message_id, accumulated_text, edit_state)
                else:
                    raise stream_err

            # Final delivery / approval pause (state is source of truth — the voice
            # mirror appends AUDIO_URL markers after streaming finishes)
            await self._finish_run(context.bot, chat_id, thread_id, accumulated_text, status_message.message_id)

        except asyncio.CancelledError:
            logger.info(f"Stream cancelled for chat_id={chat_id}")
            try:
                await context.bot.edit_message_text(
                    text="🛑 *Execution cancelled by user.*",
                    chat_id=chat_id,
                    message_id=status_message.message_id,
                    parse_mode="Markdown"
                )
            except Exception:
                pass
        except Exception as run_err:
            logger.exception("Error running agent via LangGraph client")
            error_msg = str(run_err)
            if "connect" in error_msg.lower() or "connection" in error_msg.lower():
                response_text = "❌ **Connection Error**\n\nCould not connect to the LangGraph API server."
            else:
                response_text = f"❌ **Execution Failed**\n\n`{error_msg}`"
            try:
                await context.bot.edit_message_text(
                    text=response_text,
                    chat_id=chat_id,
                    message_id=status_message.message_id,
                    parse_mode="Markdown"
                )
            except Exception:
                pass
        finally:
            if TaskTracker:
                await TaskTracker.unregister_run(str(chat_id))



# ── Bot Coordinator Manager ──────────────────────────────────────────────────

running_bots = {}  # token -> TelegramBotInstance


async def bot_coordinator():
    logger.info("Starting Telegram Bot Coordinator...")

    # ── Auto-seeding: if .env has TELEGRAM_BOT_TOKEN and table is empty ──────
    try:
        service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        env_token = os.environ.get("TELEGRAM_BOT_TOKEN")
        if env_token and not env_token.lower().startswith("your_"):
            resp = supabase.table("telegram_bots").select("id").eq("bot_token", env_token).execute()
            if not resp.data:
                if service_role_key:
                    admin_supabase = create_client(SUPABASE_URL, service_role_key)
                    users_resp = admin_supabase.auth.admin.list_users()
                    if users_resp and users_resp.users:
                        first_user_id = users_resp.users[0].id
                        supabase.table("telegram_bots").insert({
                            "user_id": first_user_id,
                            "bot_token": env_token,
                            "is_active": True
                        }).execute()
                        logger.info(f"Auto-seeded env TELEGRAM_BOT_TOKEN for user {first_user_id}")
    except Exception as se:
        logger.warning(f"Failed during bot auto-seeding check: {se}")

    while True:
        try:
            # Fetch all active bots (no workflow_id needed anymore)
            resp = supabase.table("telegram_bots").select("id, bot_token, user_id, is_active").eq("is_active", True).execute()
            active_bots = resp.data or []
            active_tokens = {bot["bot_token"] for bot in active_bots}

            # Stop bots removed from the active set
            to_stop = [token for token in list(running_bots.keys()) if token not in active_tokens]
            for token in to_stop:
                bot_instance = running_bots[token]
                await bot_instance.stop()
                del running_bots[token]
                logger.info(f"Stopped bot instance {bot_instance.bot_id[:8]}.")

            # Start new bots
            for bot in active_bots:
                token = bot["bot_token"]
                if token not in running_bots:
                    bot_instance = TelegramBotInstance(
                        bot_id=bot["id"],
                        token=token,
                        user_id=bot["user_id"]
                    )
                    running_bots[token] = bot_instance
                    asyncio.create_task(bot_instance.start())
                    logger.info(f"Queued startup for bot {bot['id'][:8]}.")

        except Exception as e:
            logger.error(f"Error in bot coordinator tick: {e}")

        await asyncio.sleep(10)


# ── Main Entrypoint ────────────────────────────────────────────────────────────

async def main_async():
    await bot_coordinator()


def main():
    logger.info("Initializing Deep Agents Telegram Bot Coordinator...")
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(main_async())
    except KeyboardInterrupt:
        logger.info("Bot coordinator terminated by KeyboardInterrupt.")
    except Exception as e:
        logger.exception(f"Unhandled exception in bot coordinator: {e}")


if __name__ == "__main__":
    main()
