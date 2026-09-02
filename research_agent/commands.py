"""Shared slash-command registry (Universal '/' interface).

All delivery surfaces (Web composer, Telegram, Discord, Slack) share this one registry.
Universal prefix: '/' (with transparent '!' fallback support).

Command kinds:
  - ``session`` : handled client/platform-side, never sent to the agent
                  (start, new, stop, status, voice toggle, help …).
  - ``agent``   : rewritten by the graph's ``preprocess_input`` node into an
                  agent instruction (e.g. /learn).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Tuple

# Universal command prefix
PLATFORM_PREFIX = "/"


@dataclass(frozen=True)
class CommandDef:
    name: str                                 # canonical name without prefix
    description: str
    category: str                             # "Session" | "Tools & Skills" | "Voice Control" | "Info"
    kind: str                                 # "session" | "agent"
    args_hint: str = ""
    aliases: Tuple[str, ...] = field(default_factory=tuple)


COMMAND_REGISTRY: tuple[CommandDef, ...] = (
    CommandDef("start",  "Select or switch the active workflow",                  "Session",        "session", aliases=("workflows",)),
    CommandDef("new",    "Start a new conversation thread",                       "Session",        "session"),
    CommandDef("stop",   "Stop and cancel active agent execution",                "Session",        "session", aliases=("cancel", "abort")),
    CommandDef("status", "Show the active workflow and thread",                 "Session",        "session"),
    CommandDef("voice",  "Voice replies: on=mirror voice, tts=always, off=never", "Voice Control",  "session", "[on|off|tts]", aliases=("voice-on", "voice-off", "voice-tts", "voice_on", "voice_off", "voice_tts")),
    CommandDef("learn",  "Learn a reusable skill from a description or this chat", "Tools & Skills", "agent", "<what to learn from>"),
    CommandDef("help",   "List available commands",                             "Info",           "session", aliases=("commands",)),
)

_COMMANDS_BY_NAME = {c.name: c for c in COMMAND_REGISTRY}
for _c in COMMAND_REGISTRY:
    for _a in _c.aliases:
        _COMMANDS_BY_NAME[_a] = _c


def resolve_command(text: str) -> Optional[Tuple[CommandDef, str]]:
    """Parse a leading command from message text.

    Accepts both ``/name args`` and ``!name args`` across all platforms.
    Returns (CommandDef, args) or None.
    """
    if not text:
        return None
    text = text.lstrip()
    if not text.startswith(("/", "!")):
        return None
    body = text[1:]
    name, _, args = body.partition(" ")
    cmd = _COMMANDS_BY_NAME.get(name.strip().lower())
    if not cmd:
        return None
    return cmd, args.strip()


def help_lines() -> list[str]:
    """Human-readable command list for /help responses."""
    lines = []
    for c in COMMAND_REGISTRY:
        hint = f" {c.args_hint}" if c.args_hint else ""
        lines.append(f"/{c.name}{hint} — {c.description}")
    return lines

