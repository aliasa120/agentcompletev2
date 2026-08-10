"""Shared slash-command registry (Hermes-lite).

Two delivery surfaces share this one registry:
  - **Web composer** — assistant-ui slash popover; `/cmd` text reaches the graph.
  - **Messaging platforms** (Telegram / Slack / Discord) — native `/` commands are
    owned by those platforms, so we use the ``!`` prefix there (e.g. ``!learn``)
    to avoid interference with the platforms' own command handling.

Command kinds:
  - ``session`` : handled client/platform-side, never sent to the agent
                  (new thread, status, voice toggle, help …).
  - ``agent``   : rewritten by the graph's ``preprocess_input`` node into an
                  agent instruction (only /learn today).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Tuple

# Prefix used on messaging platforms (web composer / is fine — it's our own UI).
PLATFORM_PREFIX = "!"


@dataclass(frozen=True)
class CommandDef:
    name: str                                 # canonical name without prefix
    description: str
    category: str                             # "Session" | "Tools & Skills" | "Info"
    kind: str                                 # "session" | "agent"
    args_hint: str = ""
    aliases: Tuple[str, ...] = field(default_factory=tuple)


COMMAND_REGISTRY: tuple[CommandDef, ...] = (
    CommandDef("new",    "Start a new conversation thread",                       "Session",        "session"),
    CommandDef("status", "Show the active workflow and thread",                 "Session",        "session"),
    CommandDef("voice",  "Voice replies: on=mirror voice, tts=always, off=never", "Session",      "session", "[on|off|tts]"),
    CommandDef("model",  "Change the agent model for this thread",              "Session",        "session"),
    CommandDef("help",   "List available commands",                             "Info",           "session", aliases=("commands",)),
    CommandDef("learn",  "Learn a reusable skill from a description or this chat", "Tools & Skills", "agent", "<what to learn from>"),
)

_COMMANDS_BY_NAME = {c.name: c for c in COMMAND_REGISTRY}
for _c in COMMAND_REGISTRY:
    for _a in _c.aliases:
        _COMMANDS_BY_NAME[_a] = _c


def resolve_command(text: str) -> Optional[Tuple[CommandDef, str]]:
    """Parse a leading command from message text.

    Accepts ``!name args`` (messaging) and ``/name args`` (web composer).
    Returns (CommandDef, args) or None.
    """
    if not text:
        return None
    text = text.lstrip()
    if not text.startswith((PLATFORM_PREFIX, "/")):
        return None
    body = text[1:]
    name, _, args = body.partition(" ")
    cmd = _COMMANDS_BY_NAME.get(name.strip().lower())
    if not cmd:
        return None
    return cmd, args.strip()


def help_lines() -> list[str]:
    """Human-readable command list for !help responses."""
    lines = []
    for c in COMMAND_REGISTRY:
        hint = f" {c.args_hint}" if c.args_hint else ""
        lines.append(f"{PLATFORM_PREFIX}{c.name}{hint} — {c.description}")
    return lines
