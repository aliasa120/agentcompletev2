#!/usr/bin/env python3
"""
email_server.py — Multi-tenant Email Gateway daemon for Deep Agents.
"""

import os
import sys
import time
import asyncio
import logging
import email
from email.mime.text import MIMEText
from email.header import decode_header
import imaplib
import smtplib
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Setup Logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger("email_server")

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


def decode_str(hdr) -> str:
    val, encoding = decode_header(hdr)[0]
    if isinstance(val, bytes):
        return val.decode(encoding or "utf-8", errors="ignore")
    return str(val)


class EmailGatewayInstance:
    def __init__(self, conn_id: str, config: dict, user_id: str):
        self.conn_id = conn_id
        self.smtp_host = config.get("smtp_host")
        self.smtp_port = int(config.get("smtp_port") or 587)
        self.username = config.get("username")
        self.password = config.get("password")
        self.imap_host = config.get("imap_host")
        self.imap_port = int(config.get("imap_port") or 993)
        self.user_id = user_id
        self.is_running = False
        # Mapping: sender_email -> thread_id
        self.active_threads = {}

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
            logger.error(f"Error fetching workflows for Email: {e}")
            return []

    async def start(self):
        self.is_running = True
        asyncio.create_task(self.poll_loop())
        logger.info(f"Email Gateway started for {self.username}.")

    async def stop(self):
        self.is_running = False
        logger.info(f"Email Gateway stopped for {self.username}.")

    async def poll_loop(self):
        while self.is_running:
            try:
                await asyncio.to_thread(self.check_emails)
            except Exception as e:
                logger.error(f"Error checking email for {self.username}: {e}")
            await asyncio.sleep(15)

    def check_emails(self):
        # Establish IMAP connection
        try:
            mail = imaplib.IMAP4_SSL(self.imap_host, self.imap_port)
            mail.login(self.username, self.password)
            mail.select("inbox")
        except Exception as conn_err:
            logger.error(f"IMAP Login failed for {self.username}: {conn_err}")
            return

        try:
            # Search for UNSEEN messages
            status, response = mail.search(None, "UNSEEN")
            if status != "OK":
                return

            mail_ids = response[0].split()
            for m_id in mail_ids:
                if not m_id:
                    continue
                # Fetch email headers and body
                status, data = mail.fetch(m_id, "(RFC822)")
                if status != "OK":
                    continue

                raw_email = data[0][1]
                msg = email.message_from_bytes(raw_email)
                
                # Extract headers
                sender = decode_str(msg.get("From"))
                subject = decode_str(msg.get("Subject", "No Subject"))
                msg_id = msg.get("Message-ID")

                # Parse sender email
                sender_email = sender
                if "<" in sender:
                    sender_email = sender.split("<")[-1].split(">")[0].strip()

                # Extract body
                body = ""
                if msg.is_multipart():
                    for part in msg.walk():
                        content_type = part.get_content_type()
                        content_disp = str(part.get("Content-Disposition"))
                        if content_type == "text/plain" and "attachment" not in content_disp:
                            payload = part.get_payload(decode=True)
                            if payload:
                                body = payload.decode(errors="ignore")
                                break
                else:
                    payload = msg.get_payload(decode=True)
                    if payload:
                        body = payload.decode(errors="ignore")

                body = body.strip()
                if not body:
                    continue

                logger.info(f"New email from {sender_email} | Subject: {subject}")
                
                # Process the email message async
                asyncio.run_coroutine_threadsafe(
                    self.process_email_message(sender_email, sender, subject, body, msg_id),
                    asyncio.get_event_loop()
                )
                
                # Mark as read/seen
                mail.store(m_id, "+FLAGS", "\\Seen")

        finally:
            try:
                mail.close()
                mail.logout()
            except Exception:
                pass

    async def process_email_message(self, sender_email: str, sender_raw: str, subject: str, body: str, reply_to_msg_id: str):
        # Determine workflow
        workflows = await self.get_enabled_workflows()
        if not workflows:
            self.send_reply(sender_email, "RE: " + subject, "❌ No active workflows available.", reply_to_msg_id)
            return

        # Default Workflow
        selected = workflows[0]
        for wf in workflows:
            if wf["name"].lower() == "default workflow":
                selected = wf
                break

        # Check if subject requests specific workflow, e.g. "Deep Agents: Blog Writer"
        subject_lower = subject.lower()
        for wf in workflows:
            if wf["name"].lower() in subject_lower:
                selected = wf
                break

        # Resolve or create thread
        thread_key = sender_email
        thread_id = self.active_threads.get(thread_key)

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

        if not thread_id:
            try:
                thread = await langgraph_client.threads.create(
                    metadata={
                        "workflow_id": selected["id"],
                        "user_id": self.user_id,
                        "email_sender": sender_email
                    }
                )
                thread_id = thread["thread_id"]
                self.active_threads[thread_key] = thread_id
            except Exception as e:
                logger.error(f"Failed to create email thread: {e}")
                self.send_reply(sender_email, "RE: " + subject, f"❌ Failed to initialize thread with LangGraph: {e}", reply_to_msg_id)
                return

        # Run LangGraph
        input_data = {"messages": [{"role": "user", "content": body}]}
        config = {
            "configurable": {
                "workflow_id": selected["id"],
                "user_id": self.user_id
            }
        }

        response_text = ""
        try:
            # We don't stream since Email is asynchronous and doesn't support real-time chunks.
            # We run to completion and fetch the result.
            run = await langgraph_client.runs.create_and_wait(
                thread_id=thread_id,
                assistant_id=RESOLVED_ASSISTANT_ID,
                input=input_data,
                config=config
            )
            
            # Fetch response
            state = await langgraph_client.threads.get_state(thread_id)
            values = state.get("values", {})
            messages = values.get("messages", [])
            if messages:
                for msg in reversed(messages):
                    role = msg.get("type") or msg.get("role")
                    if role in ("ai", "assistant"):
                        response_text = msg.get("content", "")
                        break

            if not response_text.strip():
                response_text = "🤖 Conversation completed. (No text content was generated)."

        except Exception as run_err:
            logger.error(f"LangGraph run failed: {run_err}")
            response_text = f"❌ Agent execution failed:\n\n{run_err}"

        # Send response via email
        reply_subject = subject if subject.lower().startswith("re:") else "Re: " + subject
        await asyncio.to_thread(self.send_reply, sender_email, reply_subject, response_text, reply_to_msg_id)

    def send_reply(self, to_email: str, subject: str, content: str, reply_to_msg_id: str):
        msg = MIMEText(content, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = self.username
        msg["To"] = to_email
        if reply_to_msg_id:
            msg["In-Reply-To"] = reply_to_msg_id
            msg["References"] = reply_to_msg_id

        try:
            smtp = smtplib.SMTP(self.smtp_host, self.smtp_port)
            smtp.ehlo()
            if self.smtp_port == 587:
                smtp.starttls()
                smtp.ehlo()
            smtp.login(self.username, self.password)
            smtp.sendmail(self.username, [to_email], msg.as_string())
            smtp.quit()
            logger.info(f"Sent reply email to {to_email}")
        except Exception as e:
            logger.error(f"Failed to send email to {to_email} via SMTP: {e}")


running_gateways = {}  # conn_id -> EmailGatewayInstance


async def email_coordinator():
    logger.info("Starting Email Gateway Coordinator...")
    while True:
        try:
            # Query active email connections
            resp = supabase.table("email_connections").select("*").eq("is_active", True).execute()
            active_connections = resp.data or []
            active_ids = {conn["id"] for conn in active_connections}

            # Stop inactive ones
            to_stop = [cid for cid in list(running_gateways.keys()) if cid not in active_ids]
            for cid in to_stop:
                instance = running_gateways[cid]
                await instance.stop()
                del running_gateways[cid]

            # Start new ones
            for conn in active_connections:
                cid = conn["id"]
                if cid not in running_gateways:
                    instance = EmailGatewayInstance(
                        conn_id=cid,
                        config=conn,
                        user_id=conn["user_id"]
                    )
                    running_gateways[cid] = instance
                    asyncio.create_task(instance.start())
                    logger.info(f"Spawned Email Gateway instance for {conn['username']}")

        except Exception as e:
            logger.error(f"Error in Email coordinator tick: {e}")

        await asyncio.sleep(10)


if __name__ == "__main__":
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(email_coordinator())
    except KeyboardInterrupt:
        logger.info("Email server shutdown by KeyboardInterrupt.")
