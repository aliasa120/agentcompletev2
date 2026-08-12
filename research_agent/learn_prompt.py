"""/learn prompt builder (ported from Hermes' agent/learn_prompt.py).

There is no separate "learning engine": this returns one big instruction that is
injected into the agent's input as a normal turn. The live agent then gathers
the sources itself (conversation, files, URLs) and authors the skill via the
existing ``manage_skill(action="create", ...)`` tool, which stores it in the
Supabase ``skills_library`` table. Future sessions see it via ``list_skills`` /
``read_skill`` and the @-skill mentions in the composer.
"""

from __future__ import annotations

_AUTHORING_STANDARDS = """\
SKILL AUTHORING STANDARDS (follow exactly):

Format: Markdown with YAML frontmatter at the top:
---
name: <skill_key_snake_case>
description: >-
  <one line, max 120 chars, what it does and when to use it>
category: <research | content | publishing | general>
---

Body sections, in this order:
1. `# <Skill Title>`
2. `## When to Use` — trigger phrases and situations (be specific: "use when the user asks to …")
3. `## Prerequisites` — tools or settings required (reference OUR tool names exactly)
4. `## Procedure` — numbered step-by-step instructions the agent must follow.
   Reference the actual tools available in THIS system: unified_search, unified_extract,
   youtube_transcript, think_tool, read_skill, manage_skill, text_to_speech, terminal, ask_permission,
   fetch_images_brave, view_candidate_images, analyze_images_gemini, create_post_image,
   publish_to_wordpress, save_posts_to_supabase, get_design_guide, cronjob, omni_analyzer.
5. `## Pitfalls` — mistakes to avoid, edge cases.
6. `## Verification` — how the agent checks its own output before finishing.

Rules:
- skill_key: snake_case, short, unique (check list_skills first; if it exists, UPDATE it).
- Keep the skill focused on ONE workflow. No generic advice.
- Write instructions imperative and copy-paste actionable.
"""


def build_learn_prompt(user_request: str) -> str:
    """Build the instruction injected as a normal agent turn for /learn."""
    request = (user_request or "").strip()
    if not request:
        request = "the workflow we just went through in this conversation"

    return f"""\
[/learn] The user wants you to learn a reusable skill from the request below.
Do this NOW as your reply to this message:

USER REQUEST: {request}

STEPS:
1. Understand the request. If it references a URL or file, fetch/read it with your tools.
   If it says "from this conversation" (or is empty), mine the earlier messages in this
   thread for the successful approach.
2. Distill the reusable procedure: what was the goal, what worked, in what order,
   which tools were used, what to avoid.
3. Call list_skills to check whether a similar skill already exists.
4. If similar exists → manage_skill(action="update", skill_key=..., content=...).
   Otherwise        → manage_skill(action="create", skill_key=<snake_case>,
   label=<Short Label>, description=<max 120 chars>, category=<...>, content=<FULL markdown>),
   where `content` follows the authoring standards below, and set origin="user".
5. Reply with a short confirmation: the skill key created/updated and a 2–3 line summary.

{_AUTHORING_STANDARDS}
"""


def test_build_learn_prompt() -> None:  # pragma: no cover - dev helper
    print(build_learn_prompt("how we just did the blog image pipeline"))


if __name__ == "__main__":
    test_build_learn_prompt()
