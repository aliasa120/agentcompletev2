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

# Agent feature helpers (TTS audio markers)
try:
    from research_agent.tts import extract_audio_markers
except ImportError as ie:
    logger.warning(f"research_agent helpers not importable ({ie}); audio attachments disabled")
    extract_audio_markers = lambda t: (None, False, t or "")  # noqa: E731

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
        # Mapping: sender_email -> thread_id awaiting an APPROVE/DENY reply
        self.pending_approvals = {}

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
        # Approval decision reply? ("APPROVE" / "DENY" while a command awaits approval)
        if sender_email in self.pending_approvals:
            decision_word = body.strip().split()[0].upper() if body.strip() else ""
            if decision_word in ("APPROVE", "DENY"):
                thread_id = self.pending_approvals.pop(sender_email)
                decision = "approve" if decision_word == "APPROVE" else "reject"
                await self._resume_and_reply(sender_email, subject, thread_id, {"decisions": [{"type": decision}]}, reply_to_msg_id)
                return

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
                "user_id": self.user_id,
                "platform": "email",
                "voice_mode": "off",
                "voice_input": False,
            }
        }

        try:
            # We don't stream since Email is asynchronous and doesn't support real-time chunks.
            # We run to completion and fetch the result.
            run = await langgraph_client.runs.create_and_wait(
                thread_id=thread_id,
                assistant_id=RESOLVED_ASSISTANT_ID,
                input=input_data,
                config=config
            )

            response_text, audio_url = await self._final_reply_parts(thread_id)
            if not response_text.strip():
                response_text = "🤖 Conversation completed. (No text content was generated)."

            # Pending terminal approval? Ask for an APPROVE/DENY reply instead.
            pending = await self._pending_interrupt(thread_id)
            if pending:
                reqs = pending.get("action_requests") or pending.get("actionRequests") or []
                req_data = reqs[0] if reqs else {}
                command = (req_data.get("args") or {}).get("command", "<?>")
                desc = req_data.get("description") or ""
                self.pending_approvals[sender_email] = thread_id
                reply_subject = subject if subject.lower().startswith("re:") else "Re: " + subject
                await asyncio.to_thread(
                    self.send_reply, sender_email, reply_subject,
                    "⚠️ COMMAND APPROVAL REQUIRED\n\n"
                    f"The agent wants to run this command on the server:\n\n    {command}\n\n"
                    f"{desc}\n\nReply with APPROVE or DENY as the first word of your reply.",
                    reply_to_msg_id
                )
                return

        except Exception as run_err:
            logger.error(f"LangGraph run failed: {run_err}")
            response_text = f"❌ Agent execution failed:\n\n{run_err}"
            audio_url = None

        # Send response via email (with audio attachment if the agent spoke)
        reply_subject = subject if subject.lower().startswith("re:") else "Re: " + subject
        await asyncio.to_thread(self.send_reply, sender_email, reply_subject, response_text, reply_to_msg_id, audio_url)

    async def _final_reply_parts(self, thread_id: str) -> tuple[str, str | None]:
        """Fetch the last assistant message; return (cleaned_text, audio_url)."""
        response_text = ""
        audio_url = None
        try:
            state = await langgraph_client.threads.get_state(thread_id)
            values = state.get("values", {}) if isinstance(state, dict) else {}
            messages = values.get("messages", [])
            for msg in reversed(messages):
                role = msg.get("type") or msg.get("role")
                if role in ("ai", "assistant"):
                    content = msg.get("content", "")
                    if isinstance(content, list):
                        content = "".join(
                            (b.get("text", "") if isinstance(b, dict) and b.get("type") == "text" else (b if isinstance(b, str) else ""))
                            for b in content
                        )
                    audio_url, _is_voice, response_text = extract_audio_markers(content or "")
                    break
        except Exception as e:
            logger.warning(f"Email final-state fetch failed: {e}")
        return response_text, audio_url

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

    async def _resume_and_reply(self, sender_email: str, subject: str, thread_id: str, resume_payload: dict, reply_to_msg_id: str):
        """Resume an interrupted run after an APPROVE/DENY email and send the result."""
        reply_subject = subject if subject.lower().startswith("re:") else "Re: " + subject
        config = {
            "configurable": {
                "user_id": self.user_id,
                "platform": "email",
                "voice_mode": "off",
                "voice_input": False,
            }
        }
        try:
            await langgraph_client.runs.create_and_wait(
                thread_id=thread_id,
                assistant_id=RESOLVED_ASSISTANT_ID,
                command={"resume": resume_payload},
                config=config,
            )
            # Another approval may be pending (multiple gated commands)
            pending = await self._pending_interrupt(thread_id)
            if pending:
                self.pending_approvals[sender_email] = thread_id
                reqs = pending.get("action_requests") or pending.get("actionRequests") or []
                req_data = reqs[0] if reqs else {}
                command = (req_data.get("args") or {}).get("command", "<?>")
                await asyncio.to_thread(
                    self.send_reply, sender_email, reply_subject,
                    "⚠️ ANOTHER COMMAND NEEDS APPROVAL\n\n"
                    f"    {command}\n\nReply with APPROVE or DENY as the first word of your reply.",
                    reply_to_msg_id
                )
                return

            response_text, audio_url = await self._final_reply_parts(thread_id)
            if not response_text.strip():
                response_text = "🤖 Done."
            await asyncio.to_thread(self.send_reply, sender_email, reply_subject, response_text, reply_to_msg_id, audio_url)
        except Exception as e:
            logger.error(f"Email resume failed: {e}")
            await asyncio.to_thread(self.send_reply, sender_email, reply_subject, f"❌ Failed to resume the run: {e}", reply_to_msg_id)

    def send_reply(self, to_email: str, subject: str, content: str, reply_to_msg_id: str, audio_url: str | None = None):
        from email.mime.application import MIMEApplication
        from email.mime.multipart import MIMEMultipart

        if audio_url:
            msg = MIMEMultipart()
            msg.attach(MIMEText(content, "plain", "utf-8"))
            try:
                import requests as _requests
                r = _requests.get(audio_url, timeout=60)
                r.raise_for_status()
                ext = audio_url.rsplit(".", 1)[-1][:4] or "mp3"
                part = MIMEApplication(r.content, _subtype=("ogg" if ext == "ogg" else "mpeg"))
                part.add_header("Content-Disposition", "attachment", filename=f"voice_reply.{ext}")
                msg.attach(part)
            except Exception as e:
                logger.error(f"Failed to fetch audio attachment {audio_url}: {e}")
                msg.attach(MIMEText(f"\n\n🔊 Audio reply: {audio_url}", "plain", "utf-8"))
        else:
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
