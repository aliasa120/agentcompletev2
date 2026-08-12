"""Terminal tool — executes OS shell commands with full system access.

This tool has COMPLETE access to the operating system, similar to Hermes.
It can:
- Read and write files anywhere on the filesystem
- Install packages and software
- Create documents, PDFs, and other files
- Run scripts and programs
- Access system resources

There is NO built-in approval popup for this tool: risky/critical actions are
gated by the agent calling the ``ask_permission`` tool BEFORE running the
command (see the main agent system prompt). This tool simply executes.

A hardline blocklist (rm -rf /, mkfs, dd to block devices, fork bombs,
shutdown, formatting drives, …) is ALWAYS refused and cannot be overridden.

File Visibility:
- Every file created by a command is auto-detected and uploaded to Supabase
- The tool result includes a FILE_URL:<url> line per file; the chat UI renders
  these as download/preview cards so users can see the files immediately
- The file also remains on disk at its local path (server filesystem)
- In Docker deployments, ./output and ./logs are mounted to the host so files
  are visible there too (see docker-compose.yml)
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import time
import uuid
from typing import Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

logger = logging.getLogger("research_agent.terminal")

MAX_OUTPUT_CHARS = 6000
DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 600
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB cap for auto-uploaded files

# Directories that are pointless to scan when detecting newly created files
# (huge dependency/checkpoint trees that would make every command slow).
_SKIP_DIRS = {
    "node_modules", ".venv", "venv", "env", ".git", "__pycache__",
    ".next", ".langgraph_api", "checkpoints", "site-packages",
    "dist", "build", ".cache", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "shared_npm_cache", "shared-node-modules", "Egg-info", "*.egg-info",
}

# Marker used to hand generated files to the UI, which renders them as
# download/preview cards (mirrors the AUDIO_URL: pattern used by TTS).
FILE_URL_MARKER = "FILE_URL:"

# ── Hardline blocklist — never executed, approval cannot override ───────────────

HARDLINE_PATTERNS: list[tuple[str, str]] = [
    (r"\brm\b[^\n|;&]*\s-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(?:--no-preserve-root\s+)?/(\s|$)", "recursive delete of filesystem root"),
    (r"\brm\b[^\n|;&]*\s-[a-zA-Z]*f[a-zA-Z]*r?[a-zA-Z]*\s+(?:--no-preserve-root\s+)?/(\s|$)", "recursive delete of filesystem root"),
    (r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(?:/home|/etc|/usr|/var|/bin|/sbin|/boot|/lib|/opt|~)(\s|$|/)", "recursive delete of a system/home directory"),
    (r"\bmkfs(\.\w+)?\b", "format a filesystem (mkfs)"),
    (r"\bformat\s+[a-zA-Z]:", "format a drive (Windows format)"),
    (r"\bdd\b[^\n|;&]*\bof=/dev/", "raw write to a block device"),
    (r">\s*/dev/sd[a-z0-9]", "write to a block device"),
    (r":\(\)\s*\{\s*:\|:&\s*\}\s*;:", "fork bomb"),
    (r"\b(shutdown|reboot|halt|poweroff)\b", "shutdown/reboot the machine"),
    (r"\b(init|telinit)\s+[06]\b", "shutdown/reboot via init"),
    (r"\bsystemctl\s+(poweroff|reboot|halt|kexec)\b", "shutdown/reboot via systemctl"),
    (r"\bkill\s+-(1|9)\s+-1\b", "kill every process"),
    (r"\brd\s+/s\s+/q\s+[a-zA-Z]:\\\s*$", "recursive delete of drive root (Windows rd)"),
    (r"\bdel\s+/[fsq]+[^\n]*\s+[a-zA-Z]:\\\s*$", "delete of drive root (Windows del)"),
]

# ── Dangerous patterns — require approval in smart mode ─────────────────────────

DANGEROUS_PATTERNS: list[tuple[str, str]] = [
    (r"\brm\b[^\n|;&]*\s-[a-zA-Z]*(r|f)", "recursive/forced file deletion"),
    (r"\bRemove-Item\b[^\n]*(-Recurse|-Force)", "recursive/forced deletion (PowerShell)"),
    (r"\b(del|erase)\s+/[sq]", "recursive delete (Windows del)"),
    (r"\brmdir\s+/s", "recursive delete (Windows rmdir)"),
    (r"\bfind\b[^\n]*(-delete|-exec(rm|-dir)\b)", "mass deletion via find"),
    (r"\bxargs\b[^\n]*\brm\b", "mass deletion via xargs rm"),
    (r"\bDROP\s+(TABLE|DATABASE|SCHEMA)\b", "SQL DROP"),
    (r"\bTRUNCATE\b", "SQL TRUNCATE"),
    (r"\bDELETE\s+FROM\s+\S+\s*;?\s*$", "SQL DELETE without WHERE"),
    (r"\bchmod\s+(-R\s+)?(777|666|o\+w|a\+w)\b", "world-writable permissions"),
    (r"\bchown\s+-R", "recursive ownership change"),
    (r"\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d*)\b", "pipe remote script into a shell"),
    (r"\b(iex|Invoke-Expression)\b[^\n]*(irm|Invoke-RestMethod|iwr|curl|wget)", "pipe remote script into PowerShell"),
    (r"\bpowershell(\.exe)?\s+[^\n]*(-enc|-encodedcommand)\b", "base64-encoded PowerShell command"),
    (r"\b(eval|source|\.)\s+[`$]\((curl|wget|irm|iwr|Invoke-RestMethod)", "execute downloaded code"),
    (r"\bbase64\b[^\n]*(-d|--decode)[^\n]*\|\s*(sh|bash|python\d*|powershell)", "base64-decode piped to shell"),
    (r"\bsystemctl\s+(stop|restart|disable|mask)\b", "stop/disable system services"),
    (r"\bpkill\s+-9", "force-kill processes by name"),
    (r"\bkillall\b[^\n]*(-9|-KILL)", "force-kill processes by name"),
    (r"\bkill\s+-9\s+-1", "kill all user processes"),
    (r"\bgit\s+push\b[^\n]*(--force\b|-f\b)", "force-push (rewrites remote history)"),
    (r"\bgit\s+reset\s+--hard", "hard reset (discards working changes)"),
    (r"\bgit\s+clean\s+-[a-zA-Z]*f", "delete untracked files"),
    (r"\bgit\s+branch\s+-D\b", "force-delete a branch"),
    (r"\bdocker(-|\s)compose\b[^\n]*\b(down|kill|stop)\b", "stop/remove docker compose services"),
    (r"\bdocker\s+(rm|stop|kill|system\s+prune)\b", "stop/remove docker containers"),
    (r"\bdd\s+if=", "raw disk copy (dd)"),
    (r"\b(echo|cat|printf|tee)\b[^\n]*>{1,2}\s*[^\n]*(\.env|\.ssh|\.aws|\.netrc|id_rsa|credentials)", "overwrite shell/credential files"),
    (r"\b(sed\s+-i|perl\s+-[a-z]*i|ruby\s+-[a-z]*i)\b[^\n]*(\.env|\.ssh|\.aws|config\.ya?ml)", "in-place edit of credential/config files"),
    (r"\b(sh|bash|cmd|powershell)\s*<<", "execute heredoc script"),
    (r"\bnet\s+user\b[^\n]*/add", "create OS user accounts"),
    (r"\b(reg\s+add|reg\s+delete)\b", "modify the Windows registry"),
    (r"\bsetx\b", "persistently modify Windows environment variables"),
]

_BENIGN_RE = re.compile(
    r"^\s*(ls|dir|pwd|cd|echo|cat|type|head|tail|grep|findstr|rg|find\b(?!.*-delete)|which|where|"
    r"python(\d*)?\s+-(c|-version)|pip\s+(list|show|freeze)|node\s+-(v|e)|npm\s+(list|run\s+(?!.*rm))|"
    r"git\s+(status|log|diff|show|branch\b(?!.*-D)|remote\s+-v)|whoami|hostname|date|curl\s+-I|"
    r"ffmpeg\s+-version|Get-ChildItem|Get-Content|Get-Location|Test-Path)\b",
    re.IGNORECASE,
)


def upload_file_to_supabase(file_path: str, user_id: Optional[str] = None) -> Optional[str]:
    """Upload a file to Supabase Storage and return the public URL.
    
    This makes files created by the terminal tool visible to users.
    Files are stored under ``terminal/YYYY-MM-DD/`` so a daily cleanup cron can
    delete entire day-folders older than 30 days.
    """
    try:
        import datetime
        from supabase import create_client
        
        supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if not supabase_url or not key:
            logger.warning("[terminal] Supabase not configured, cannot upload file")
            return None
        
        if not os.path.exists(file_path):
            logger.warning(f"[terminal] File does not exist: {file_path}")
            return None
        
        client = create_client(supabase_url, key)
        today = datetime.date.today().isoformat()
        filename = os.path.basename(file_path)
        unique_id = str(uuid.uuid4())[:8]
        storage_path = f"terminal/{today}/{unique_id}_{filename}"
        
        with open(file_path, "rb") as f:
            file_content = f.read()
        
        # Determine content type
        ext = filename.lower().split(".")[-1] if "." in filename else ""
        content_type_map = {
            "pdf": "application/pdf",
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "gif": "image/gif",
            "webp": "image/webp",
            "svg": "image/svg+xml",
            "mp3": "audio/mpeg",
            "wav": "audio/wav",
            "ogg": "audio/ogg",
            "m4a": "audio/mp4",
            "mp4": "video/mp4",
            "webm": "video/webm",
            "txt": "text/plain",
            "md": "text/markdown",
            "csv": "text/csv",
            "json": "application/json",
            "html": "text/html",
            "py": "text/x-python",
            "js": "text/javascript",
            "ts": "text/typescript",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "zip": "application/zip",
        }
        content_type = content_type_map.get(ext, "application/octet-stream")
        
        client.storage.from_("uploads").upload(
            path=storage_path,
            file=file_content,
            file_options={"content-type": content_type},
        )
        
        public_url = f"{supabase_url}/storage/v1/object/public/uploads/{storage_path}"
        logger.info(f"[terminal] File uploaded to Supabase: {public_url}")
        return public_url
    except Exception as e:
        logger.error(f"[terminal] Failed to upload file to Supabase: {e}")
        return None


def detect_hardline(command: str) -> Optional[str]:
    """Return block reason if command matches the hardline blocklist."""
    for pattern, desc in HARDLINE_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return desc
    return None


def detect_dangerous(command: str) -> Optional[str]:
    """Return risk description if command needs approval (smart mode).

    Dangerous patterns are checked FIRST so a benign-looking verb can't smuggle
    a dangerous payload past the list (e.g. ``echo KEY=1 >> .env``).
    """
    for pattern, desc in DANGEROUS_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return desc
    if _BENIGN_RE.match(command.strip()):
        return None
    return "unrecognized command (not on the safe-list)"


def _run_command(command: str, workdir: Optional[str], timeout: int) -> str:
    cwd = workdir if workdir else os.getcwd()
    if workdir:
        workdir = os.path.expanduser(workdir)
        if not os.path.isdir(workdir):
            return f"❌ workdir does not exist: {workdir}"
        cwd = workdir

    cmd = (command or "").strip()

    # ── Heredoc support: cat > file << 'DELIM' ... DELIM [&&/; trailing cmd] ──
    # cmd.exe has no heredocs, so we intercept the block, write the file directly,
    # and run any commands that follow the closing delimiter (agents commonly
    # chain `...EOF\npython3 script.py` in one call).
    heredoc_match = re.search(
        r"cat\s*(?:>\s*(\S+)\s*)?<<\s*['\"]?([A-Za-z0-9_-]+)['\"]?\s*(?:>\s*(\S+)\s*)?\n(.*?)\n\2(?=\s*(?:\n|$))",
        cmd,
        re.DOTALL,
    )
    heredoc_notes = []
    run_command = cmd
    if heredoc_match:
        target_file = heredoc_match.group(1) or heredoc_match.group(3)
        file_content = heredoc_match.group(4)
        if target_file:
            if target_file.startswith("/c/"):
                target_file = "C:/" + target_file[3:]
            target_path = os.path.join(cwd, target_file) if not os.path.isabs(target_file) else target_file
            try:
                os.makedirs(os.path.dirname(target_path), exist_ok=True)
                with open(target_path, "w", encoding="utf-8") as f:
                    f.write(file_content)
                public_url = upload_file_to_supabase(target_path)
                url_msg = f"\n{FILE_URL_MARKER}{public_url}" if public_url else ""
                heredoc_notes.append(
                    f"✅ Written heredoc file to {target_path} ({len(file_content)} bytes){url_msg}"
                )
            except Exception as fe:
                heredoc_notes.append(f"❌ Failed writing heredoc file: {fe}")
        # Anything after the closing delimiter (e.g. `python3 script.py`) still runs.
        run_command = (cmd[: heredoc_match.start()] + cmd[heredoc_match.end() :]).strip()

    if not run_command:
        # Heredoc-only call (no trailing command) — nothing to execute.
        return "$ " + cmd + "\n(exit 0)\n" + "\n\n".join(heredoc_notes) if heredoc_notes else "$ " + cmd + "\n(exit 0)\n(no output)"

    def _walk_files(base: str):
        """Yield files under base, skipping heavy dependency/checkpoint dirs."""
        try:
            for root, dirs, files in os.walk(base):
                dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
                for f in files:
                    yield os.path.join(root, f)
        except Exception:
            return

    # Snapshot existing files to detect newly created output files
    before_files = set()
    try:
        if os.path.exists(cwd):
            before_files = set(_walk_files(cwd))
    except Exception:
        pass

    timeout = max(1, min(int(timeout), MAX_TIMEOUT))
    try:
        proc = subprocess.run(
            run_command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return f"⏱️ Command timed out after {timeout}s and was killed."
    except Exception as e:
        return f"❌ Failed to execute command: {e}"

    out = proc.stdout or ""
    err = proc.stderr or ""
    combined = out if not err.strip() else (out + ("\n" if out else "") + ("STDERR:\n" + err))
    if len(combined) > MAX_OUTPUT_CHARS:
        head = combined[:2000]
        tail = combined[-4000:]
        combined = f"{head}\n… [truncated {len(combined) - 6000} chars] …\n{tail}"
    if not combined.strip():
        combined = "(no output)"

    # Detect ANY newly created file (any extension) and upload it so the user
    # can see/download it. A path that didn't exist before the command ran is a
    # new file; also catch in-place rewrites via mtime within the last few seconds.
    uploaded_files = []
    try:
        if os.path.exists(cwd):
            now = time.time()
            for full_p in _walk_files(cwd):
                if full_p in before_files:
                    continue
                try:
                    if os.path.getsize(full_p) > MAX_UPLOAD_BYTES:
                        logger.info(f"[terminal] Skipping upload of large file: {full_p}")
                        continue
                except OSError:
                    continue
                url = upload_file_to_supabase(full_p)
                if url:
                    uploaded_files.append((full_p, url))
    except Exception as e:
        logger.warning(f"[terminal] Output file upload check failed: {e}")

    result_text = f"$ {cmd}\n(exit {proc.returncode})\n{combined.strip()}"
    if heredoc_notes:
        result_text += "\n\n" + "\n\n".join(heredoc_notes)
    if uploaded_files:
        notes = []
        for full_p, url in uploaded_files:
            notes.append(
                f"📄 Generated File: {os.path.basename(full_p)}\n"
                f"{FILE_URL_MARKER}{url}\n"
                f"   Local path: {full_p}"
            )
        result_text += "\n\n" + "\n\n".join(notes)
        result_text += (
            "\n\nTell the user the files are ready and include the download links "
            "(they are also shown as file cards in the chat)."
        )
    return result_text


@tool(parse_docstring=True)
def terminal(
    command: str,
    workdir: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Execute an OS shell command with full system access and return its output.

    This tool has COMPLETE access to the operating system, similar to Hermes.
    You can:
    - Create files and documents (PDFs, images, scripts, etc.)
    - Install packages and software
    - Access and modify files anywhere on the filesystem
    - Run any program or script
    - Access system resources and hardware

    Use for real system operations the user asks for: running scripts,
    installing packages, inspecting files/processes, git operations, reading
    server logs (the logs/ directory), installing packages, etc.
    Commands run as the server's OS user (cmd.exe on Windows, sh on Linux).

    Examples of what you can do:
    - Create a PDF with charts: write a Python script that uses reportlab /
      matplotlib, then run it (e.g. `python make_report.py`).
    - Install a package: `pip install matplotlib`
    - Create an image: `python -c "from PIL import Image; ..."`
    - Run a script: `python script.py`
    - Inspect server logs: `tail -n 100 logs/server_stdout.log`
    - Access system info: `uname -a` or `systeminfo`

    Files you create are automatically detected, uploaded, and returned with a
    FILE_URL marker so the chat UI shows them as downloadable file cards.
    The file also stays on disk at its local path (server filesystem).

    Safety: before running a risky/destructive command you MUST first call
    ``ask_permission(action=..., reason=...)`` and only execute once the user
    approves. Catastrophic commands (rm -rf /, formatting drives, fork bombs,
    shutdown, raw writes to block devices) are always refused by this tool.

    Args:
        command: The full shell command line to execute.
        workdir: Optional working directory (absolute path). Defaults to the
                 server process directory. You can use this to specify where
                 to create files (e.g., the user's home directory).
        timeout: Max seconds to wait (default 120, max 600).

    Returns:
        The command's exit code and combined stdout/stderr (truncated), or a
        block notice for hardline-blocked commands. Created files are listed
        with a FILE_URL:<url> line that the UI renders as a file card.
    """
    command = (command or "").strip()
    if not command:
        return "❌ Empty command."

    # 1. Hardline blocklist — always refused, no override
    hardline = detect_hardline(command)
    if hardline:
        logger.warning(f"[terminal] HARDLINE blocked: {command!r} ({hardline})")
        return (
            f"⛔ BLOCKED — this command is on the hardline blocklist ({hardline}) "
            "and can never be executed, regardless of approval. Do NOT retry it."
        )

    # 2. Execute — file detection + upload + FILE_URL markers happen inside
    # _run_command (it knows the cwd and can diff before/after file sets).
    risk = detect_dangerous(command)
    logger.info(f"[terminal] executing (risk={risk or 'none'}): {command}")
    return _run_command(command, workdir, timeout)
