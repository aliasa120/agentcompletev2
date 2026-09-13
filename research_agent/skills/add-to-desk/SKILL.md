---
name: add-to-desk
description: >
  Add to Desk — the user's office desk for delegated tasks with real-world side
  effects. Use the add_to_desk tool to deposit a fully prepared task card
  (details + editable arguments + buttons bound to tool schemas) so the user can
  review it and execute with ONE click. Covers when to use the Desk, card
  anatomy, field/button specs, and the email/PDF workflow example.
---

# Add to Desk Skill

The Desk is the user's **office desk**: the place where the agent parks finished
work that has real-world side effects, instead of executing it blindly. Humans
don't fully trust agents with irreversible actions — sending an email to the
boss, publishing a post, messaging someone, spending money, deleting data.

With the Desk the flow becomes:

1. User: "Mail my boss that I'm not coming in today — add it to my desk."
2. Agent does **all** the work itself: finds the boss's email address, writes
   the email body, decides the subject line.
3. Agent calls `add_to_desk` with the prepared task card: argument fields the
   user can edit (recipient, subject, body) + a "Send Email" button bound to
   the send-email tool schema with the prepared defaults.
4. Agent tells the user: "The email is ready on your Desk."
5. User opens **Settings → Desk**, sees the task card, edits anything they
   want (change the wording, the recipient...), and clicks **Send** — one click.
   Or clicks **Reject Task** — the card and its files are deleted.

No mid-chat permission interrupts. No scrolling through chat to edit tool
arguments. The user is the final trigger for every irreversible action.

---

## When to use the Desk

**Use `add_to_desk` when:**

- The user explicitly asks: "...add it to my desk", "...put it on my desk",
  "...but let me approve it first", "...I'll send it myself", "...ask me before".
- The action is **irreversible or externally visible**: emails, messages to
  people, social posts, publishing, payments, orders, deletions, API calls that
  mutate third-party systems.
- The user seems cautious about the outcome (boss, client, public post).

**Do NOT use the Desk when:**

- The user clearly wants immediate execution AND the tool's permission mode is
  already `always_allow` (execute directly as usual).
- The task has no real-world side effect (research, writing files to the
  workspace, summaries, analysis) — just do it and report.
- The user asked for something fully autonomous/scheduled — use `cronjob`.

**Golden rule:** do the entire task yourself. Only the **final irreversible
step** goes on the Desk. Never deposit a card that says "agent will figure out
the arguments later" — the card must be complete and executable as-is.

---

## How tools are tagged — and why it matters for Desk cards

Every tool assigned to you has a **loading mode** (set in Tools & MCP settings):

| Mode | What you see | How to call it |
|---|---|---|
| `primary` | Fully bound as a real tool with its schema in your context | Call the tool directly |
| `normal` | Listed by name + short description in `<available_tools>` | `load_tools` to get its schema → `call_tool` to run it |
| `super` | Only a per-connection summary in `<super_index_mcps>` (e.g. "gmail (61 tools active)") | `list_tools` to discover names → `load_tools` for the schema → `call_tool` to run it |

**Desk buttons bypass `call_tool`** — the click executes the FINAL tool
directly with your saved args. That means the button must carry the tool's
**exact key and real argument names**, which you can only know after loading
the schema.

### Mandatory workflow before creating ANY card with an MCP tool

1. **Discover the exact tool key** (skip if you already know it):
   `list_tools {"mcp_name": "<connection>"}` → note the exact key,
   e.g. `GMAIL_SEND_EMAIL`. Tool keys are **case-sensitive** and usually
   UPPERCASE for MCP tools — never guess or lowercase them.
2. **Load the real schema**: `load_tools {"tool_names": ["GMAIL_SEND_EMAIL"]}`
   → read `function.parameters` carefully: argument names, types, required
   fields. Do NOT invent argument names — Gmail uses `recipient_email`, not
   `to`. If `load_tools` returns empty or fails, retry once; if it still
   fails, do not bind the button — tell the user instead.
3. **Prepare the final arguments** from that schema (write the email body,
   find the recipient, generate the file...).
4. **Create the card** binding the button to the exact tool key with the
   schema's argument names.

### Validation feedback (self-correction)

`add_to_desk` validates every execute button before saving the card:

- **Unknown tool key** → the create fails with the error and a
  `did_you_mean` list of close matches. Re-create with the exact key.
- **Case mismatch** → auto-corrected (e.g. `gmail_send_email` →
  `GMAIL_SEND_EMAIL`) and reported in `warnings`.
- **Args not in the schema** / **missing required args** → the card is saved
  but `warnings` + `validated_tool_schemas` come back in the result, showing
  the real argument names. If warnings appear, fix the card with
  `action: "update"` and the same `task_id` so the one-click button works.

---

## Card anatomy

A card has four parts. All of them come from you, the agent:

1. **Task details** — `title`, `summary`, and `user_prompt` (the exact user
   request that initiated the task). This is the audit trail: what it is, how
   it started, what you prepared.
2. **Editable fields** — the card's argument form. Each field becomes an input
   the user can tweak before executing.
3. **Buttons** — the actions. Every execute button is bound to a **tool schema**
   (the exact tool you would have called + the prepared arguments). A
   "Reject Task" button is added automatically — rejecting deletes the card and
   all its files, so you almost never need to define one yourself.
4. **Files** — paths of artifacts you produced while preparing the task
   (relative to the current thread's workspace, e.g. `report.pdf`). They show
   as attachments; rejecting the task deletes them.

### Field spec

| key | required | notes |
|---|---|---|
| `name` | yes | **Must match the tool argument it fills** (or set `arg_key`). |
| `label` | no | Human label shown above the input. |
| `type` | yes | `text`, `textarea`, `number`, `select`, `readonly`. |
| `value` | yes | Your prepared default (the whole point of the card). |
| `required` | no | Mark arguments the user must not leave empty. |
| `options` | select only | e.g. `["Send now", "Schedule for 9am"]`. |
| `help` | no | Small hint text under the input. |

Use `textarea` for long content (email bodies, captions), `readonly` for
prepared content the user should see but not edit, `select` when there are a
few valid choices.

### Button spec

| key | required | notes |
|---|---|---|
| `id` | no | Stable id, e.g. `send`. |
| `label` | yes | Button text, e.g. "Send Email". |
| `kind` | yes | `execute` (default) — `cancel` is auto-added by the UI. |
| `tool_name` | execute only | The **FINAL tool name** the button runs — e.g. `gmail_send_email`, exactly the name you pass to `call_tool`. **Never bind the button to the `call_tool` wrapper itself** (it would nest the real call and break one-click execution). |
| `tool_type` | no | `builtin` or `mcp`. |
| `args` | execute only | The full argument dict of the FINAL tool with your prepared defaults. Edited field values are merged into it at click time by field `name`/`arg_key`. |
| `style` | no | `primary` for the main action. |
| `description` | no | Shown under the button ("Sends via Gmail"). |

**How the one-click works:** when the user clicks an execute button, the bound
tool runs with `args` overridden by any edited fields. Your card click =
your tool call, just user-approved. No schema is attached to reject/cancel —
the task simply vanishes and its files are deleted.

---

## Worked example — "make a PDF report and email it to my boss, add to my desk"

You would call `add_to_desk` like this (concepts, not literal JSON):

- Do the work first: research the topic, write `report.pdf` into the thread
  workspace (e.g. `reports/report.pdf`), find the boss's email.
- `action`: `"create"`
- `title`: `"Email monthly report PDF to boss"`
- `summary`: `"I researched this month's KPIs, wrote the 4-page report
  (reports/report.pdf), and prepared the email below. Click Send to deliver it."`
- `user_prompt`: `"make a pdf report and send to my boss, add it to my desk"`
- `fields`:
  - `{"name": "to", "label": "To", "type": "text", "value": "boss@company.com", "required": true}`
  - `{"name": "subject", "label": "Subject", "type": "text", "value": "Monthly Report — September"}`
  - `{"name": "body", "label": "Email message", "type": "textarea", "value": "Hi ..., attached is this month's report..."}`
- `buttons`:
  - `{"id": "send", "label": "Send Email", "kind": "execute", "style": "primary",
     "tool_name": "gmail_send_email", "tool_type": "mcp",
     "args": {"to": "boss@company.com", "subject": "Monthly Report — September",
              "body": "Hi ..., attached is this month's report...", "attachment": "reports/report.pdf"}}``
- `files`: `["reports/report.pdf"]`

The user opens the Desk, sees the card with the PDF attached, tweaks the
message if they like, and clicks **Send Email**. Done.

---

## Rules of thumb

- **One card = one task.** Don't bundle unrelated sends.
- **Field names = tool arg names.** That's how edits flow into the call.
- **Bind buttons to the final tool, never `call_tool`.** If you reached the
  tool through dynamic routing (`load_tools` → `call_tool`), put the inner
  tool's name and ITS argument dict on the button, not the router call.
- **Args must be complete.** Every required tool argument must be present in
  the button's `args` (fields fill the editable ones).
- **List every file.** Anything you created for this task goes in `files`, so
  rejecting the task cleans it all up.
- **Report back in chat.** After `create`, tell the user the task is waiting on
  their Desk (Settings → Desk) and what they can edit.
- **Sensitive credentials** never go in fields — reference connection configs,
  not passwords/API keys.
- If the user asks to change a pending card, use `add_to_desk` with
  `action: "update"` and the `task_id` from the create result.
