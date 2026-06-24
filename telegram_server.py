#!/usr/bin/env python3
"""
telegram_server.py — Multi-tenant dynamic Telegram bot manager for Deep Agents.

This script:
1. Connects to Supabase to fetch bot tokens and bindings.
2. Dynamically spawns and stops bot polling tasks as bots are added/removed in the UI.
3. Coordinates message requests to the LangGraph API Server (default http://localhost:2024).
4. Employs user-specific and workflow-specific thread mapping for memory and state isolation.
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
    from telegram import Update
    from telegram.ext import (
        Application,
        CommandHandler,
        MessageHandler,
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
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "").strip()
LANGGRAPH_API_URL = os.environ.get("LANGGRAPH_API_URL", "http://localhost:2024").strip()

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

async def set_active_workflow(chat_id: int, workflow_id: str, thread_id: str):
    """Set the active workflow and thread ID for a chat in telegram_chat_bindings."""
    loop = asyncio.get_running_loop()
    try:
        # 1. Deactivate current active bindings for this chat
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


def format_agent_response(text: str) -> str:
    if not text:
        return ""
    return format_markdown_tables(text)


# ── Telegram Bot Instance Wrapper ─────────────────────────────────────────────

class TelegramBotInstance:
    """Manages the life cycle and event handlers of a single Telegram Bot connection."""
    
    def __init__(self, bot_id: str, token: str, workflow_id: str, user_id: str, workflow_name: str):
        self.bot_id = bot_id
        self.token = token
        self.workflow_id = workflow_id
        self.user_id = user_id
        self.workflow_name = workflow_name
        self.application = None

    async def start(self):
        """Build and asynchronously run the bot polling."""
        builder = Application.builder().token(self.token)
        
        # Configure proxy if configured
        telegram_proxy = os.environ.get("TELEGRAM_PROXY", "").strip()
        if telegram_proxy:
            builder.proxy(telegram_proxy)

        self.application = builder.build()
        
        # Add handlers
        self.application.add_handler(CommandHandler("start", self.start_command))
        self.application.add_handler(CommandHandler("status", self.status_command))
        self.application.add_handler(CommandHandler("clear", self.clear_command))
        self.application.add_handler(CommandHandler("newthread", self.clear_command))
        self.application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.handle_message))

        await self.application.initialize()
        await self.application.start()
        await self.application.updater.start_polling()
        logger.info(f"Bot {self.bot_id[:8]} successfully started for workflow '{self.workflow_name}'")

    async def stop(self):
        """Gracefully stop the polling loop and release resources."""
        if self.application:
            try:
                await self.application.updater.stop()
                await self.application.stop()
                await self.application.shutdown()
            except Exception as e:
                logger.warning(f"Error stopping bot application {self.bot_id[:8]}: {e}")
            logger.info(f"Bot {self.bot_id[:8]} successfully terminated.")

    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        welcome_msg = (
            f"👋 Welcome! I am your Telegram Bot connected to the **{self.workflow_name}** workflow.\n\n"
            "Any message you send here will be handled directly by this workflow, maintaining your persistent memory.\n\n"
            "Commands:\n"
            "📌 /status - View active thread context\n"
            "🔄 /clear - Reset the conversation thread"
        )
        await update.message.reply_text(welcome_msg, parse_mode="Markdown")

    async def status_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        chat_id = update.effective_chat.id
        thread_id = await get_thread_for_workflow(chat_id, self.workflow_id)
        
        if thread_id:
            status_msg = (
                "📌 **Current Status**\n\n"
                f"👤 **Chat ID:** `{chat_id}`\n"
                f"🤖 **Workflow:** `{self.workflow_name}`\n"
                f"🧵 **Thread ID:** `{thread_id}`"
            )
        else:
            status_msg = (
                "📌 **Current Status**\n\n"
                f"🤖 **Workflow:** `{self.workflow_name}`\n"
                "❌ No active conversation thread found. Send a message to start one."
            )
        await update.message.reply_text(status_msg, parse_mode="Markdown")

    async def clear_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        chat_id = update.effective_chat.id
        try:
            thread = await langgraph_client.threads.create(
                metadata={"workflow_id": self.workflow_id, "user_id": self.user_id, "telegram_chat_id": str(chat_id)}
            )
            thread_id = thread["thread_id"]
            logger.info(f"Created new LangGraph thread {thread_id} for chat {chat_id} via /clear command")

            await set_active_workflow(chat_id, self.workflow_id, thread_id)

            await update.message.reply_text(
                f"🔄 **Conversation Reset!**\n\n"
                f"🤖 **Workflow:** `{self.workflow_name}`\n"
                f"🧵 **New Thread ID:** `{thread_id}`\n\n"
                "Your previous history in this chat is cleared.",
                parse_mode="Markdown"
            )
        except Exception as e:
            logger.exception("Error clearing conversation")
            await update.message.reply_text(f"❌ Failed to reset conversation: {e}")

    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        if not is_user_allowed(update.effective_user):
            await update.message.reply_text("⛔ Access denied.")
            return

        chat_id = update.effective_chat.id
        user_text = update.message.text

        # 1. Fetch or create thread
        thread_id = await get_thread_for_workflow(chat_id, self.workflow_id)
        if not thread_id:
            try:
                thread = await langgraph_client.threads.create(
                    metadata={"workflow_id": self.workflow_id, "user_id": self.user_id, "telegram_chat_id": str(chat_id)}
                )
                thread_id = thread["thread_id"]
                await set_active_workflow(chat_id, self.workflow_id, thread_id)
            except Exception as e:
                logger.error(f"Failed to create new thread: {e}")
                await update.message.reply_text("❌ Failed to initialize conversation thread.")
                return

        # 2. Send placeholder and typing status
        status_message = await update.message.reply_text("🤖 _Agent is thinking..._", parse_mode="Markdown")
        await context.bot.send_chat_action(chat_id=chat_id, action="typing")

        # 3. Resolve assistant ID
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

        # 4. Verify thread existence
        try:
            await langgraph_client.threads.get(thread_id)
        except Exception as te:
            if "not found" in str(te).lower():
                logger.info(f"Thread {thread_id} not found in LangGraph. Recreating a new one...")
                try:
                    thread = await langgraph_client.threads.create(
                        metadata={"workflow_id": self.workflow_id, "user_id": self.user_id, "telegram_chat_id": str(chat_id)}
                    )
                    thread_id = thread["thread_id"]
                    await set_active_workflow(chat_id, self.workflow_id, thread_id)
                except Exception as ce:
                    logger.error(f"Failed to recreate missing thread: {ce}")

        input_data = {"messages": [{"role": "user", "content": user_text}]}
        config = {
            "configurable": {
                "workflow_id": self.workflow_id,
                "user_id": self.user_id
            }
        }

        accumulated_text = ""
        last_edit_text = ""
        last_edit_time = 0.0

        # 5. Stream from LangGraph
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
                                    pass

            # Fallback thread state recovery
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
                    logger.error(f"Fallback thread state recovery failed: {fe}")

            if accumulated_text.strip():
                formatted_response = format_agent_response(accumulated_text)
                try:
                    await context.bot.edit_message_text(
                        text=formatted_response,
                        chat_id=chat_id,
                        message_id=status_message.message_id,
                        parse_mode="Markdown"
                    )
                except Exception:
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
            error_msg = str(run_err)
            if "connect" in error_msg.lower() or "connection" in error_msg.lower():
                response_text = "❌ **Connection Error**\n\nCould not connect to the LangGraph API server. Please check that your backend is running."
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


# ── Bot Coordinator Manager ──────────────────────────────────────────────────

running_bots = {}  # token -> TelegramBotInstance

async def bot_coordinator():
    logger.info("Starting Telegram Bot Coordinator...")
    
    # ── Auto-seeding check ───────────────────────────────────────────────────
    try:
        service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        env_token = os.environ.get("TELEGRAM_BOT_TOKEN")
        if env_token and not env_token.lower().startswith("your_"):
            resp = supabase.table("telegram_bots").select("id").eq("bot_token", env_token).execute()
            if not resp.data:
                # Token not registered in database. Auto-seed it under the first user
                if service_role_key:
                    admin_supabase = create_client(SUPABASE_URL, service_role_key)
                    users_resp = admin_supabase.auth.admin.list_users()
                    if users_resp and users_resp.users:
                        first_user_id = users_resp.users[0].id
                        
                        # Get first active workflow
                        wf_resp = supabase.table("workflows").select("id").eq("enabled", True).limit(1).execute()
                        default_wf_id = wf_resp.data[0]["id"] if wf_resp.data else None
                        
                        # Insert bot
                        supabase.table("telegram_bots").insert({
                            "user_id": first_user_id,
                            "bot_token": env_token,
                            "workflow_id": default_wf_id,
                            "is_active": True
                        }).execute()
                        logger.info(f"Auto-seeded env TELEGRAM_BOT_TOKEN to database for user {first_user_id}")
    except Exception as se:
        logger.warning(f"Failed during bot auto-seeding check: {se}")

    while True:
        try:
            # Query active bots from database
            resp = supabase.table("telegram_bots").select("id, bot_token, workflow_id, user_id, is_active, workflows(name)").eq("is_active", True).execute()
            active_bots = resp.data or []
            active_tokens = {bot["bot_token"] for bot in active_bots}
            
            # 1. Stop bots that are no longer active/present
            to_stop = [token for token in list(running_bots.keys()) if token not in active_tokens]
            for token in to_stop:
                bot_instance = running_bots[token]
                await bot_instance.stop()
                del running_bots[token]
                logger.info(f"Stopped bot instance {bot_instance.bot_id[:8]}.")

            # 2. Start new bots
            for bot in active_bots:
                token = bot["bot_token"]
                if token not in running_bots:
                    wf_name = bot.get("workflows", {}).get("name", "Default Workflow") if bot.get("workflows") else "Default Workflow"
                    bot_instance = TelegramBotInstance(
                        bot_id=bot["id"],
                        token=token,
                        workflow_id=bot["workflow_id"],
                        user_id=bot["user_id"],
                        workflow_name=wf_name
                    )
                    running_bots[token] = bot_instance
                    asyncio.create_task(bot_instance.start())
                    logger.info(f"Queued startup task for Telegram bot {bot['id'][:8]}.")

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
