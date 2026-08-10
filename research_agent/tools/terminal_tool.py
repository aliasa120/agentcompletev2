"""Terminal tool — executes OS shell commands on the server.

There is NO built-in approval popup for this tool: risky/critical actions are
gated by the agent calling the ``ask_permission`` tool BEFORE running the
command (see the main agent system prompt). This tool simply executes.

A hardline blocklist (rm -rf /, mkfs, dd to block devices, fork bombs,
shutdown, formatting drives, …) is ALWAYS refused and cannot be overridden.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
from typing import Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

logger = logging.getLogger("research_agent.terminal")

MAX_OUTPUT_CHARS = 6000
DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 600

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
    cwd = None
    if workdir:
        workdir = os.path.expanduser(workdir)
        if not os.path.isdir(workdir):
            return f"❌ workdir does not exist: {workdir}"
        cwd = workdir

    timeout = max(1, min(int(timeout), MAX_TIMEOUT))
    try:
        proc = subprocess.run(
            command,
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
    return f"$ {command}\n(exit {proc.returncode})\n{combined.strip()}"


@tool(parse_docstring=True)
def terminal(
    command: str,
    workdir: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """Execute an OS shell command on the server and return its output.

    Use for real system operations the user asks for: running scripts,
    installing packages, inspecting files/processes, git operations, etc.
    Commands run as the server's OS user (cmd.exe on Windows, sh on Linux).

    Safety: before running a risky/destructive command you MUST first call
    ``ask_permission(action=..., reason=...)`` and only execute once the user
    approves. Catastrophic commands (rm -rf /, formatting drives, fork bombs,
    shutdown, raw writes to block devices) are always refused by this tool.

    Args:
        command: The full shell command line to execute.
        workdir: Optional working directory (absolute path). Defaults to the
                 server process directory.
        timeout: Max seconds to wait (default 120, max 600).

    Returns:
        The command's exit code and combined stdout/stderr (truncated), or a
        block notice for hardline-blocked commands.
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

    # 2. Execute
    risk = detect_dangerous(command)
    logger.info(f"[terminal] executing (risk={risk or 'none'}): {command}")
    return _run_command(command, workdir, timeout)
