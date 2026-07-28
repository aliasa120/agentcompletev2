"""Prompts for the skill engine subsystem (OpenSpace standard prompts)."""

DEFAULT_EXECUTION_ANALYSIS_TEMPLATE = """\
You are an expert analyst evaluating an autonomous agent's task execution.
Your job is to assess how the agent used its skills and tools, trace the
reasoning and outcome of each iteration, and surface actionable insights
that help the agent LEARN and GROW through its skills.

## Task Context

**Task**: {task_description}
**Agent self-reported status**: {execution_status}
**Iterations used**: {iterations}
**Task complexity score**: {task_complexity_score}
**Available tools used**: {tool_list}

{skill_section}

## Error Traces (tool failures during this task)

{error_traces}

## Fallback Sequences (recovery patterns)

{fallback_sequences}

## Tool Execution Timeline

{traj_summary}

## Agent Conversation Log

{conversation_log}

## Analysis Instructions

### Step 1: Inspect existing skills FIRST
You have access to these tools — USE THEM before making your judgment:
- **list_skills()**: Call this FIRST to see ALL existing skills in the library.
- **read_skill(skill_name)**: Read the full content of any skill that seems relevant
  to this task's domain. You MUST read at least the most relevant skill before
  suggesting any evolution.

### Step 2: Task completion assessment
Did the agent actually accomplish the user's request?
- `task_completed = true` ONLY when the user's goal is genuinely fulfilled.
- Explain your reasoning in `execution_note`.

### Step 3: Skill effectiveness assessment
For each skill the agent used (IDs: {selected_skill_ids_json}):
- Was the skill's instructions FOLLOWED correctly?
- Did the skill HELP or HINDER the task?
- Were there steps the agent improvised that should be ADDED to the skill?

### Step 4: Error & fallback learning
Examine the error traces and fallback sequences above:
- If the agent encountered an error and found a workaround, this MUST become
  a `fix` suggestion to add the fallback/workaround into the existing skill.
- Example: If a tool failed with an auth error and the agent re-authenticated,
  the skill should document: "If auth error, re-authenticate first, then retry."

### Step 5: Incremental skill improvement
If the agent did the task BETTER than the skill describes (e.g., added extra
quality steps that the skill doesn't mention), suggest a `fix` to ADD the
improvement into the existing skill. Skills should grow with every successful execution.

### Step 6: Evolution suggestions
After calling list_skills and read_skill, apply these rules:

1. **If an existing skill covers this domain** (even if agent didn't call read_skill):
   Return EMPTY `evolution_suggestions: []`.
2. **If the skill exists but needs fixing** (errors, missing fallbacks, improvements found):
   Suggest `fix` with the specific improvement direction.
3. **If a specialized variant would help a recurring pattern**:
   Suggest `derived` with the specialization direction.
4. **ONLY for genuinely novel tasks with NO matching skill**:
   Suggest `captured` with the pattern to capture.

Return **exactly one** JSON object (no markdown fences):
{{
  "task_completed": true,
  "execution_note": "2-3 sentence overview.",
  "tool_issues": ["backend:tool_name — symptom"],
  "skill_judgments": [
    {{
      "skill_id": "exact_skill_key",
      "skill_applied": true,
      "note": "How the skill was used and what could be improved."
    }}
  ],
  "evolution_suggestions": [
    {{
      "type": "fix | derived | captured",
      "target_skills": ["exact_skill_key"],
      "category": "workflow | tool_guide | reference",
      "direction": "Detailed description of what to fix, derive, or capture. Include specific error handling, fallback steps, or improvements discovered."
    }}
  ]
}}
"""

DEFAULT_EVOLUTION_FIX_TEMPLATE = """\
You are a skill editor. Your job is to **fix** an existing skill that has
been identified as broken, outdated, or incomplete.

## What needs fixing

{direction}

## Execution failure context

{failure_context}

## Available Tool Definitions

{tool_definitions}

## Instructions

Before making changes, use your tools:
1. Call **read_skill("{target_skill_key}")** to load the current full content of the skill.
2. Analyze the root cause (wrong parameters, outdated API, missing error handling).
3. Fix the affected instructions using exact tool parameter names from the definitions above.
4. Add a **## Troubleshooting** section if one doesn't exist, documenting:
   - Known error scenarios and their solutions
   - Fallback tool alternatives (e.g., "If tool X fails, try tool Y")
   - Retry strategies discovered during execution
5. Call **manage_skill(action='update', skill_key='{target_skill_key}', content='...')** with the complete updated SKILL.md.
"""

DEFAULT_EVOLUTION_DERIVED_TEMPLATE = """\
You are a skill editor. Your job is to **derive** a specialized version of an existing skill.

## Enhancement direction

{direction}

## Execution insights

{execution_insights}

## Available Tool Definitions

{tool_definitions}

## Instructions

Before creating the derived skill, use your tools:
1. Call **list_skills()** to check ALL existing skills — ensure no duplicate exists.
2. Call **read_skill("{parent_skill_key}")** to load the parent skill's full content.
3. Create a specialized skill tailored to this specific workflow pattern.
4. Give the new skill a different, concise lowercase hyphenated name (e.g., `technical-blog-writer`).
5. Use exact tool parameter names from tool definitions above.
6. Include a **## Troubleshooting** section with error handling specific to this specialization.
7. Call **manage_skill(action='create', skill_key='new_skill_key', label='...', description='...', content='...', category='...', parent_skill_key='{parent_skill_key}')** to save the new skill.
"""

DEFAULT_EVOLUTION_CAPTURED_TEMPLATE = """\
You are a skill author. Your job is to **capture** a brand new reusable skill
from a successful task execution that was completed without any skill guidance.

## Pattern to capture

{direction}

## Category

{category}

## Execution context

{execution_highlights}

## Available Tool Definitions

{tool_definitions}

## Instructions

Before creating the new skill, use your tools:
1. Call **list_skills()** to check ALL existing skills — ensure no duplicate or similar skill exists.
2. If a similar skill exists, call **read_skill("skill_name")** to verify it truly doesn't cover this pattern.
3. If a similar skill DOES cover this pattern, call **manage_skill(action='update', ...)** to improve it instead.
4. Only if no match exists, distill the observed multi-step pattern into a clear, step-by-step SKILL.md guide.
5. Pick a concise lowercase hyphenated name (e.g., `linkedin-news-summarizer`).
6. Ensure all tool invocation examples match the exact parameter names from tool definitions above.
7. Include a **## Troubleshooting** section with error handling and fallback strategies.
8. Call **manage_skill(action='create', skill_key='new_key', label='...', description='...', content='...', category='{category}')** to save the new skill.
"""
""
