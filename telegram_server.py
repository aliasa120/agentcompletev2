#!/usr/bin/env python3
"""
telegram_server.py — Standalone Telegram bot integration for Deep Agents.

This script:
1. Connects to Supabase to fetch workflows and manage chat-to-workflow bindings.
2. Directs chat requests to the LangGraph API Server (default http://localhost:2024).
3. Supports real-time token streaming with throttled message edits.
4. Allows users to switch active workflows interactively via inline buttons.

Usage:
    python telegram_server.py
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
    from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
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
    from supabase import create_client, Client
except ImportError:
    logger.error("supabase is not installed. Run: uv pip install supabase")
    sys.exit(1)

try:
    from langgraph_sdk import get_client
except ImportError:
    logger.error("langgraph-sdk is not installed. Run: uv pip install langgraph-sdk")
    sys.exit(1)

# Env config validation
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "").strip()
LANGGRAPH_API_URL = os.environ.get("LANGGRAPH_API_URL", "http://localhost:2024").strip()

if not TELEGRAM_BOT_TOKEN:
    logger.error("TELEGRAM_BOT_TOKEN is missing from .env")
    sys.exit(1)

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    logger.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env")
    sys.exit(1)

# Initialize Supabase
try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    logger.info("Supabase client initialized successfully.")
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

# ── Supabase Bindings Helper Functions ──────────────────────────────────────────

async def get_active_workflows() -> list[dict]:
    """Fetch active workflows from Supabase."""
    loop = asyncio.get_running_loop()
    try:
        # Wrap blocking Supabase sync call in an executor
        resp = await loop.run_in_executor(
            None,
            lambda: supabase.table("workflows").select("id, name, description").execute()
        )
        return resp.data or []
    except Exception as e:
        logger.error(f"Error fetching workflows: {e}")
        return []

async def get_active_binding(chat_id: int) -> dict | None:
    """Get the active workflow binding and thread ID for a chat."""
    loop = asyncio.get_running_loop()
    try:
        resp = await loop.run_in_executor(
            None,
            lambda: supabase.table("telegram_chat_bindings")
            .select("workflow_id, thread_id, workflows(name)")
            .eq("chat_id", str(chat_id))
            .eq("is_active", True)
            .execute()
        )
        if resp.data:
            row = resp.data[0]
            wf_name = row.get("workflows", {}).get("name", "Unknown Workflow")
            return {
                "workflow_id": row["workflow_id"],
                "thread_id": row["thread_id"],
                "workflow_name": wf_name
            }
        return None
    except Exception as e:
        logger.error(f"Error getting active binding: {e}")
        return None

async def set_active_workflow(chat_id: int, workflow_id: str, thread_id: str):
    """Set the active workflow and thread ID for a chat."""
    loop = asyncio.get_running_loop()
    try:
        # 1. Deactivate current active bindings
        await loop.run_in_executor(
            None,
            lambda: supabase.table("telegram_chat_bindings")
            .update({"is_active": False})
            .eq("chat_id", str(chat_id))
            .execute()
        )
        # 2. Upsert the selected workflow binding
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
        logger.info(f"Updated binding for chat {chat_id} to workflow {workflow_id} (thread {thread_id})")
    except Exception as e:
        logger.error(f"Error setting active workflow: {e}")
        raise

async def get_thread_for_workflow(chat_id: int, workflow_id: str) -> str | None:
    """Check if a thread ID already exists for this chat and workflow combo."""
    loop = asyncio.get_running_loop()
    try:
        resp = await loop.run_in_executor(
            None,
            lambda: supabase.table("telegram_chat_bindings")
            .select("thread_id")
            .eq("chat_id", str(chat_id))
            .eq("workflow_id", workflow_id)
            .execute()
        )
        if resp.data:
            return resp.data[0]["thread_id"]
        return None
    except Exception as e:
        logger.error(f"Error getting thread for workflow: {e}")
        return None

# ── Command Handlers ───────────────────────────────────────────────────────────

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command. Welcomes user and prompts workflow selection."""
    if not is_user_allowed(update.effective_user):
        await update.message.reply_text("⛔ Access denied. You are not on the allowlist.")
        return

    welcome_msg = (
        "👋 Welcome to the **Deep Agents** Telegram Integration!\n\n"
        "Here you can talk directly to your custom workflows compiled from Supabase. "
        "Each workflow maintains its own separate thread context, allowing you to switch "
        "seamlessly between tasks.\n\n"
        "Please select a workflow to start chatting:"
    )
    await update.message.reply_text(welcome_msg, parse_mode="Markdown")
    await workflows_command(update, context)

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /status command. Displays active workflow and thread context."""
    if not is_user_allowed(update.effective_user):
        await update.message.reply_text("⛔ Access denied.")
        return

    chat_id = update.effective_chat.id
    binding = await get_active_binding(chat_id)
    if binding:
        status_msg = (
            "📌 **Current Status**\n\n"
            f"👤 **Chat ID:** `{chat_id}`\n"
            f"🤖 **Active Workflow:** `{binding['workflow_name']}`\n"
            f"🧵 **LangGraph Thread:** `{binding['thread_id']}`\n\n"
            "To switch workflows, type `/workflows`."
        )
    else:
        status_msg = (
            "📌 **Current Status**\n\n"
            "❌ No workflow is currently connected to this chat.\n"
            "Please use `/workflows` to select one."
        )
    await update.message.reply_text(status_msg, parse_mode="Markdown")

async def workflows_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /workflows command. Fetches and lists active workflows."""
    if not is_user_allowed(update.effective_user):
        await update.message.reply_text("⛔ Access denied.")
        return

    workflows = await get_active_workflows()
    if not workflows:
        await update.message.reply_text(
            "⚠️ No active workflows found in database. Make sure you have created workflows "
            "and run the database migrations."
        )
        return

    keyboard = []
    for wf in workflows:
        btn_text = wf["name"]
        keyboard.append([InlineKeyboardButton(btn_text, callback_data=f"select_wf:{wf['id']}:{wf['name']}")])

    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text("Select a workflow to connect to this chat:", reply_markup=reply_markup)

async def clear_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /clear or /newthread command. Creates a new thread for the active workflow."""
    if not is_user_allowed(update.effective_user):
        await update.message.reply_text("⛔ Access denied.")
        return

    chat_id = update.effective_chat.id
    binding = await get_active_binding(chat_id)
    if not binding:
        await update.message.reply_text(
            "❌ No workflow is currently connected to this chat.\n"
            "Please use `/workflows` to select one."
        )
        return

    workflow_id = binding["workflow_id"]
    workflow_name = binding["workflow_name"]

    try:
        # Create a fresh thread in LangGraph API with metadata
        thread = await langgraph_client.threads.create(
            metadata={"workflow_id": workflow_id, "user_id": str(chat_id)}
        )
        thread_id = thread["thread_id"]
        logger.info(f"Created new LangGraph thread {thread_id} for chat {chat_id} via /clear command")

        # Save the active workflow binding in Supabase
        await set_active_workflow(chat_id, workflow_id, thread_id)

        await update.message.reply_text(
            f"🔄 **Conversation Reset!**\n\n"
            f"🤖 **Workflow:** `{workflow_name}`\n"
            f"🧵 **New Thread ID:** `{thread_id}`\n\n"
            f"A new thread has been created. Your previous history for this workflow in this chat is cleared.",
            parse_mode="Markdown"
        )
    except Exception as e:
        logger.exception("Error clearing conversation")
        await update.message.reply_text(f"❌ Failed to reset conversation: {e}")

# ── Callback Query Handling (Workflow Selection) ─────────────────────────────

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle workflow selection button click."""
    query = update.callback_query
    await query.answer()

    if not is_user_allowed(query.from_user):
        await query.edit_message_text("⛔ Access denied.")
        return

    data = query.data
    if data.startswith("select_wf:"):
        _, workflow_id, workflow_name = data.split(":", 2)
        chat_id = query.message.chat_id

        # Send alert that we are setting it up
        await query.edit_message_text(f"⏳ Connecting chat to `{workflow_name}`...")

        try:
            # Create a fresh thread in LangGraph API every time a workflow is selected/switched
            thread = await langgraph_client.threads.create(
                metadata={"workflow_id": workflow_id, "user_id": str(chat_id)}
            )
            thread_id = thread["thread_id"]
            logger.info(f"Created new LangGraph thread {thread_id} for chat {chat_id}")

            # Save the active workflow binding in Supabase
            await set_active_workflow(chat_id, workflow_id, thread_id)

            confirm_msg = (
                f"✅ **Connected Successfully!**\n\n"
                f"🤖 **Workflow:** `{workflow_name}`\n"
                f"🧵 **Thread ID:** `{thread_id}`\n\n"
                f"Any message you send now will be handled by **{workflow_name}**. "
                "Enjoy!"
            )
            await query.edit_message_text(confirm_msg, parse_mode="Markdown")

        except Exception as e:
            logger.exception("Error selecting workflow")
            await query.edit_message_text(f"❌ Failed to connect workflow: {e}")

# ── Table Formatting Helpers ──────────────────────────────────────────────────

def is_separator_line(line: str) -> bool:
    """Check if a line looks like a markdown table separator (e.g. |---|---|)."""
    line_strip = line.strip()
    if not line_strip:
        return False
    # Must contain at least one '|'
    if "|" not in line_strip:
        return False
    # Must contain only hyphens, colons, vertical bars, and whitespace
    allowed_chars = set("|-: \t")
    if not set(line_strip).issubset(allowed_chars):
        return False
    # Must contain at least one hyphen
    if "-" not in line_strip:
        return False
    return True

def _render_ascii_table(header: str, data_lines: list[str]) -> str:
    """Formats a markdown table into a aligned ASCII table wrapped in a monospace block."""
    import re
    def clean_cell(cell: str) -> str:
        # Strip bold ** and __
        c = re.sub(r"\*\*|__", "", cell)
        # Strip italic * and _
        c = re.sub(r"\*|_", "", c)
        # Strip backticks
        c = re.sub(r"`", "", c)
        # Strip links like [text](url) -> text
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
    
    # Pad all rows to have the same number of columns
    for row in all_rows:
        while len(row) < num_cols:
            row.append("")
            
    # Calculate column widths
    col_widths = [0] * num_cols
    for row in all_rows:
        for idx, cell in enumerate(row):
            col_widths[idx] = max(col_widths[idx], len(cell))
            
    # Format rows
    formatted_lines = []
    
    # 1. Header row
    header_line = " | ".join(cell.ljust(col_widths[idx]) for idx, cell in enumerate(header_cells))
    formatted_lines.append(header_line)
    
    # 2. Separator line
    sep_line = "-+-".join("-" * col_widths[idx] for idx in range(num_cols))
    formatted_lines.append(sep_line)
    
    # 3. Data rows
    for row in rows_cells:
        row_line = " | ".join(cell.ljust(col_widths[idx]) for idx, cell in enumerate(row))
        formatted_lines.append(row_line)
        
    return "```\n" + "\n".join(formatted_lines) + "\n```"

def format_markdown_tables(text: str) -> str:
    """Detects markdown tables in text and replaces them with aligned ASCII tables in monospace code blocks."""
    lines = text.split("\n")
    processed_lines = []
    i = 0
    n = len(lines)
    
    while i < n:
        line = lines[i]
        if is_separator_line(line):
            if i > 0:
                # Pop the header line from processed_lines
                header = processed_lines.pop()
                
                # Collect data lines
                data_lines = []
                j = i + 1
                while j < n:
                    data_line = lines[j]
                    if "|" in data_line and not is_separator_line(data_line):
                        data_lines.append(data_line)
                        j += 1
                    else:
                        break
                
                # Format the table
                formatted_table = _render_ascii_table(header, data_lines)
                processed_lines.append(formatted_table)
                
                i = j
                continue
                
        processed_lines.append(line)
        i += 1
        
    return "\n".join(processed_lines)

def format_agent_response(text: str) -> str:
    """Format the agent's response for Telegram."""
    if not text:
        return ""
    # Process and format markdown tables
    return format_markdown_tables(text)

# ── Message Handling & Real-time Streaming ─────────────────────────────────────

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle text messages from the user, route to LangGraph and stream response."""
    if not is_user_allowed(update.effective_user):
        await update.message.reply_text("⛔ Access denied.")
        return

    chat_id = update.effective_chat.id
    user_text = update.message.text

    # Fetch active binding
    binding = await get_active_binding(chat_id)
    if not binding:
        await update.message.reply_text(
            "❌ No workflow is connected to this chat.\n"
            "Please use /workflows to select a workflow first."
        )
        return

    workflow_id = binding["workflow_id"]
    thread_id = binding["thread_id"]

    # Send a thinking placeholder message
    status_message = await update.message.reply_text("🤖 _Agent is thinking..._", parse_mode="Markdown")
    
    # Send typing status
    await context.bot.send_chat_action(chat_id=chat_id, action="typing")

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

    # Verify if thread exists in LangGraph. Recreate it if missing/expired.
    try:
        await langgraph_client.threads.get(thread_id)
    except Exception as te:
        if "not found" in str(te).lower():
            logger.info(f"Thread {thread_id} not found in LangGraph. Recreating a new one...")
            try:
                thread = await langgraph_client.threads.create(
                    metadata={"workflow_id": workflow_id, "user_id": str(chat_id)}
                )
                thread_id = thread["thread_id"]
                # Save the new active thread ID in Supabase
                await set_active_workflow(chat_id, workflow_id, thread_id)
            except Exception as ce:
                logger.error(f"Failed to recreate missing thread: {ce}")
        else:
            logger.warning(f"Unexpected error validating thread existence: {te}")

    input_data = {"messages": [{"role": "user", "content": user_text}]}
    config = {
        "configurable": {
            "workflow_id": workflow_id,
            "user_id": str(chat_id)
        }
    }

    accumulated_text = ""
    last_edit_text = ""
    last_edit_time = 0.0

    try:
        # Stream events from the LangGraph server using the resolved assistant ID
        async for chunk in langgraph_client.runs.stream(
            thread_id=thread_id,
            assistant_id=RESOLVED_ASSISTANT_ID,
            input=input_data,
            config=config,
            stream_mode="messages"
        ):
            # Parse token deltas from the stream (handles both dict and StreamPart objects)
            if isinstance(chunk, dict):
                event_type = chunk.get("event")
                data = chunk.get("data", [])
            else:
                event_type = getattr(chunk, "event", None)
                data = getattr(chunk, "data", [])
            
            if event_type == "messages/partial":
                for msg in data:
                    content = ""
                    if isinstance(msg, dict):
                        content = msg.get("content", "")
                    else:
                        content = getattr(msg, "content", "")
                    
                    if content:
                        accumulated_text += content
                        
                        # Throttle message edits to once every 1.5 seconds to avoid Telegram 429
                        now = time.time()
                        if now - last_edit_time > 1.5 and accumulated_text.strip() != last_edit_text.strip():
                            try:
                                await context.bot.edit_message_text(
                                    text=accumulated_text + " ▉",
                                    chat_id=chat_id,
                                    message_id=status_message.message_id
                                )
                                last_edit_text = accumulated_text
                                last_edit_time = now
                            except Exception:
                                # Safe to ignore transient telegram edit exceptions (e.g. rate limit)
                                pass

        # Fallback: if accumulated_text is empty, grab the latest assistant message from thread state.
        # This protects against stream mode inconsistencies.
        if not accumulated_text.strip():
            logger.info("Stream yielded no partial tokens. Attempting fallback thread state recovery...")
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
                logger.error(f"Fallback thread state recovery failed: {fe}")

        # Final edit to strip the cursor and present the full output
        if accumulated_text.strip():
            formatted_response = format_agent_response(accumulated_text)
            try:
                await context.bot.edit_message_text(
                    text=formatted_response,
                    chat_id=chat_id,
                    message_id=status_message.message_id,
                    parse_mode="Markdown"
                )
            except Exception as e:
                logger.warning(f"Failed to send response with Markdown formatting, sending as plain text: {e}")
                # Fall back to plain text but keep the ASCII-formatted table structure
                await context.bot.edit_message_text(
                    text=formatted_response,
                    chat_id=chat_id,
                    message_id=status_message.message_id
                )
        else:
            await context.bot.edit_message_text(
                text="🤖 Done. (No response content was generated.)",
                chat_id=chat_id,
                message_id=status_message.message_id
            )

    except Exception as run_err:
        logger.exception("Error running agent via LangGraph client")
        
        # Check if it looks like a connection error (LangGraph server is offline)
        error_msg = str(run_err)
        if "connect" in error_msg.lower() or "connection refused" in error_msg.lower() or "unreachable" in error_msg.lower():
            response_text = (
                "❌ **Connection Error**\n\n"
                "Could not connect to the LangGraph API server. Please make sure the backend is active:\n"
                "`langgraph dev`"
            )
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

# ── Main Entrypoint ────────────────────────────────────────────────────────────

def main():
    logger.info("Starting Deep Agents Telegram Bot...")
    
    # Initialize application builder
    builder = Application.builder().token(TELEGRAM_BOT_TOKEN)
    
    # Configure proxy if set in env (useful in regions where Telegram is blocked)
    telegram_proxy = os.environ.get("TELEGRAM_PROXY", "").strip()
    if telegram_proxy:
        logger.info(f"Setting up network proxy: {telegram_proxy}")
        builder.proxy(telegram_proxy)
        
    application = builder.build()

    # Register handlers
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("workflows", workflows_command))
    application.add_handler(CommandHandler("status", status_command))
    application.add_handler(CommandHandler("clear", clear_command))
    application.add_handler(CommandHandler("newthread", clear_command))
    application.add_handler(CallbackQueryHandler(handle_callback))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Start long polling
    logger.info("Bot is polling. Press Ctrl+C to stop.")
    application.run_polling()

if __name__ == "__main__":
    main()
