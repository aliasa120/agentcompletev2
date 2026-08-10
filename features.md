hy i wants to copy smart features like i have seen that hermes creates pdfs files ,etc and slash commands like learn command etc this ,and hermes can reply in audio as well 
we have to works on these three features from hermes to in our agent 
tell me how these three features are implmented in it an



11:47

▸
Worked · 1 step
I'll help you understand these three Hermes features and how to implement them in our agent. Let me first look at our project structure and research how Hermes implements these features.


Expert Financial Support for Therapists
Ad
Streamline your practice finances with Heard’s all-in-one bookkeeping, tax planning, and payroll platform.
joinheard.com ↗

▸
Worked · 3 steps
The project has a local hermes-agent-main checkout — perfect source of truth. Let me explore both our agent and Hermes' implementation.


▸
Worked · 3 steps

Formpost
Ad
Automate your agent's data collection by turning HTML contact forms into direct email submissions with Formpost.
formpost.ai ↗
Hermes' full source is checked out locally. Let me search for the three feature implementations inside it.


▸
Worked · 4 steps

Benchmark Report: Why Your MCP Tools Fail
Ad
Your agent picks the wrong tool? It's not the model, it's your schema. We tested 14 models to prove it.
arcade.dev ↗
Let me look at the actual structure of Hermes' directories.


▸
Worked · 4 steps
Found the key files. Let me read the implementations and find the PDF tooling.


▸
Worked · 10 steps

Rebolt: All-in-One Home Service CRM
Ad
Automate your home service business with Rebolt’s AI voice assistant and all-in-one marketing tools.
rebolthq.com ↗
The read tool is blocking those files. Let me read them via terminal instead.


▸
Worked · 2 steps
Files are readable via terminal. Now let me find the PDF generation and slash command implementations.


▸
Worked · 9 steps
Found it — PDF generation is a bundled skill in Hermes. Let me read the PDF skill, the /learn handler, and check our own agent's structure.


▸
Worked · 3 steps
Now let me examine our own agent's structure to give concrete implementation guidance.


▸
Worked · 3 steps
Let me check how Hermes' TTS integrates with the agent loop, the /learn prompt construction, and how our Telegram server currently replies.


▸
Worked · 5 steps
I have the complete picture now. Let me check our project dependencies quickly, then write up the analysis.


▸
Worked · 2 steps
Here's the full breakdown. I read the actual Hermes source (you have it checked out at hermes-agent-main/) and mapped each feature to how it would land in our stack (LangGraph deep-research agent + Telegram/Discord/Slack/Email bridges).

1. PDF creation — Hermes does NOT have a hardcoded PDF tool
PDFs are created by a bundled skill: skills/productivity/pdf/SKILL.md (docs: hermes-agent-main/website/docs/user-guide/skills/bundled/productivity/productivity-pdf.md).

The mechanics:

A skill is just a markdown file with frontmatter (name, description, when-to-use triggers) plus instructions.
When you say "make a PDF", the skill router sees the trigger phrase, injects the skill's SKILL.md into the model's context.
The skill's instructions tell the agent to pip install pypdf pdfplumber reportlab, then write and run a Python script — e.g. SimpleDocTemplate("report.pdf") + Paragraph/story + doc.build(story). The agent itself generates the PDF via code execution; there's no create_pdf API call anywhere.
The same skill covers merge/split (pypdf PdfWriter), form filling, watermarking, OCR.
So in Hermes' model: file creation = agent + instructions + code execution. No bespoke tool needed.

2. Slash commands + /learn
Two layers:

Registry — hermes_cli/commands.py. Every command is a CommandDef dataclass (name, description, category, aliases, args_hint, subcommands, cli_only/gateway_only). One COMMAND_REGISTRY list is the single source of truth — CLI help, autocomplete, Telegram BotCommands, and Slack mappings all derive from it. /learn is one entry: CommandDef("learn", "Learn a reusable skill from anything you describe...", "Tools & Skills", args_hint="<what to learn from>").

Dispatch — when the input starts with /, the input layer resolves the command against the registry and calls a handler (_handle_learn_command in hermes_cli/cli_commands_mixin.py).

The clever part of /learn: the handler contains almost no logic. It calls agent/learn_prompt.py → build_learn_prompt(user_request), which returns one big standards-guided prompt, and injects that prompt into the agent's input queue as a normal turn. The live agent then:

Gathers the sources itself (reads the dir with read_file/search_files, fetches URLs with web_extract, or uses the current conversation — "learn from what we just did").
Authors a SKILL.md file via its skill_manage tool, following the authoring rules embedded in the prompt (≤60-char description, exact section order, Hermes-tool framing).
The result is a reusable skill on disk that future sessions load into the system prompt. There is no separate "learning engine" — the LLM writes the skill, and the skills system stores + reloads it. (agent/learning_graph.py only powers the "learning journey" timeline visualization.)

3. Audio replies
tools/tts_tool.py exposes text_to_speech_tool(text=...) — a normal tool the model can call, registered in toolsets.py. The model decides when to reply with audio based on the request.
Provider architecture: one tool, many backends behind lazy imports — Edge TTS (default, free, no API key), ElevenLabs, OpenAI, MiniMax, Mistral, Gemini, xAI, plus local ones (Piper, KittenTTS, NeuTTS) and custom shell-command providers via config.
Formats: Opus .ogg for Telegram voice bubbles (needs ffmpeg), MP3 for CLI/Discord/WhatsApp.
Input side: tools/transcription_tools.py (STT) transcribes incoming voice messages; voice_mode.py / hermes_cli/voice.py wire full voice-in/voice-out.
Key takeaway: all three features are the same pattern — tool + instructions + platform adapter. PDF = code-execution skill, /learn = command that becomes a prompt, audio = a TTS tool. The agent just needs tools; the platform bridges need to dispatch commands and deliver media.

How to port these into our agent
Our stack maps cleanly: agent.py (deepagents/LangGraph) is where tools get added, research_agent/prompts.py is where instructions live, and telegram_server.py / discord_server.py / slack_server.py are the platform adapters.

PDF creation
Option A (Hermes-style, cheap): add a run_python/code-execution capability + write a pdf_skill.md instructions file loaded into the system prompt when the user mentions PDF; the agent writes a reportlab script and runs it.
Option B (deterministic, better for us): add a dedicated @tool in agent.py — create_pdf(markdown: str, filename: str) -> file_url. Use fpdf2 or reportlab (not yet in pyproject.toml — needs adding). Have it write to output/ and upload to Supabase Storage (the Telegram server already uses that pattern for uploads). The tool returns the public URL.
Delivery: our platform servers currently only stream text. Add a file-delivery hook: telegram_server.py → context.bot.send_document(chat_id, document=...), Discord → discord.File, Slack → files_upload_v2, email → attachment. Detect the file from the tool result or a [file: URL] marker in the streamed text.
Slash commands + /learn
Create commands.py with a COMMAND_REGISTRY-style list of CommandDefs (name, description, args_hint, handler).
In each platform server, intercept messages starting with / before routing to the agent. Telegram already uses CommandHandler for /start and /status — add a generic filters.Text handler that resolves unknown /x against the registry. Slack: route message.im texts beginning with /; Discord: prefix commands.
/learn MVP (Hermes pattern, no engine): build_learn_prompt(request) → inject as a normal agent turn with instructions to write skills/<name>/SKILL.md via a new write_skill tool. Then at startup agent.py globs skills/*/SKILL.md and appends them to the system prompt — that's the whole "learning" loop.
Optionally add /pdf, /new, /help the same way — one registry drives all platforms, exactly like Hermes.
Audio replies
Add edge-tts to pyproject.toml (free, no API key) — or openai TTS if you already have an OpenAI key.
Add a text_to_speech(text) -> file_url @tool in agent.py that synthesizes to output/ and uploads to Supabase.
Add one line to the system prompt in research_agent/prompts.py: "If the user asks for an audio/voice reply, call text_to_speech and return the file URL."
Delivery: in telegram_server.py, after the run completes, if the final message references an audio file, call context.bot.send_voice(chat_id, voice=url) (Telegram voice notes need Opus/.ogg — ffmpeg converts MP3→ogg). Discord: send(file=...) in an audio channel. Slack: files_upload_v2.
Bonus (voice input, nearly free): your Telegram server already downloads voice notes (line ~610 in telegram_server.py). Add a transcription step (OpenAI Whisper API or local faster-whisper) that turns voice.ogg into text before it goes to the agent — that's Hermes' transcription_tools.py role.
Order I'd build it: slash-command registry first (it's small, unblocks /learn and /pdf UX), then text_to_speech + Telegram voice replies (fastest visible win), then the PDF tool, then /learn with the skills directory.

One caveat: your platform servers stream text-only responses from LangGraph, so the biggest actual change is a file-delivery path (tool → file → Supabase/disk → platform send) — everything else is a tool + a prompt line.

Want me to start implementing one of these? I'd suggest the slash-command registry + /learn first since it's the foundation.


Build slash-command registry + /learn

Add text_to_speech + Telegram voice replies

Add create_pdf tool + file delivery

Add voice input transcription

Give feedback

tell me how much access of instance hermes agent has means he can uses terminal etc


11:52

▸
Worked · 1 step
Let me dig into Hermes' permission/security model to answer precisely.


▸
Worked · 14 steps

Smarter Segmentation & Analytics for Shopify Brands
Ad
Scale your ecommerce revenue with Postscript's AI-powered SMS marketing and automated, personalized messaging.
postscript.io ↗
Here's the complete picture of what a Hermes agent instance can access, straight from its source (tools/approval.py, tools/terminal_tool.py, and website/docs/user-guide/security.md).

Short answer: it runs as your OS user
Hermes is not an API-restricted bot — it's a full agent that executes as the same OS user you run it as. It can do roughly everything you could do by typing in your own terminal. There is no built-in sandbox by default; the "security" is human approval gates, not isolation (container isolation is an optional backend).

What it can do (its toolset)
Capability	How
Terminal	terminal tool — arbitrary shell commands. Backends: local (default, your machine), ssh (a remote box), docker/singularity/modal/daytona (containers)
Filesystem	read_file, write_file, search_files, patch, file ops — anywhere the OS user can reach. Also pip install, run scripts → this is how it creates PDFs (writes a reportlab script, runs it)
Network	web_search, web_extract, browser tool, and curl/wget via terminal
Everything else	TTS audio, image generation, cron jobs, email/Telegram/Discord/Slack sending, memory, delegation to sub-agents, MCP servers (which can add arbitrary new tools), optional computer-use
The gates on that access
1. Dangerous command approval (approvals.mode in config) — the main human-in-the-loop check, run before every terminal command:

smart (default): an auxiliary LLM judges risk — safe commands (e.g. python -c "print(1)") auto-approve, clearly destructive ones auto-deny, uncertain ones prompt you
manual: always prompt
off / --yolo / /yolo: skip all prompts
Triggers: rm -r, mkfs, dd if=, chmod 777, DROP TABLE, systemctl stop, kill -9 -1, bash -c, curl | sh, writing to /etc/ or ~/.ssh/, etc.

Approval prompt gives four choices: once / session / always (saved to a permanent allowlist in config.yaml) / deny. Timeout is fail-closed (300s → denied).

2. Hardline blocklist (always-on floor, even in YOLO mode) — rm -rf /, fork bombs, mkfs.* on mounted root, dd ... of=/dev/*, piping URLs to sh at rootfs level. No override exists; the command just returns an error.

3. User-defined deny rules (approvals.deny) — your own glob patterns ("git push --force*") that block commands before YOLO is consulted. "Run everything except these, ever."

4. File write safety — write_file/patch check paths against: protected-path denylist (~/.ssh/, ~/.aws/, .env, credential stores — always blocked, no prompt) and optional HERMES_WRITE_SAFE_ROOT (hard block outside listed dirs; the Docker image sets this to /opt/data). ⚠️ But the docs are explicit: the terminal tool can still cat > those same files — write guards are "defense in depth, not a hard boundary."

5. User authorization (when exposed on messaging platforms) — who can even talk to the agent: platform allowlists (TELEGRAM_ALLOWED_USERS=...), global GATEWAY_ALLOWED_USERS, DM pairing codes, and deny-by-default if nothing is configured.

6. Container isolation (optional) — if you set terminal.backend: docker, the security boundary moves to the container: --cap-drop ALL, no-new-privileges, --pids-limit 256, no-exec tmpfs, resource limits. Inside a container, dangerous-command checks are skipped because the container can't touch the host. This is the only mode that actually sandboxes a compromised agent.

How this compares to our agent
Our LangGraph agent (agent.py, research_agent/) is on the opposite end: it has search tools only (tavily, exa, linkup, think_tool) — no terminal, no file writes, no network calls beyond search. It's far more locked down than Hermes, which is why in the previous analysis the features (PDF, /learn, audio) needed adding tools to it.

If you want Hermes-style terminal access, the natural port is: add a terminal tool to agent.py + a tools/approval.py-style pattern check (rm -rf, dd, etc.) that makes the Telegram/Discord server ask the user "approve/deny" before running flagged commands. That gives you the 80% value of Hermes' model with much less surface area.

Want me to sketch or implement that approval-gated terminal tool for our agent?

hy this is my chat with another agent about hermes featurees and our agent gap 
we have to implment tts audio so agent can able to ans in tts
i wants logic how it response in tts means how agent khows ans gives by tts or simple text like in telegram i chat though voice and he gives his ans in voice
and if i type text he ans in text or how hermes handles or system handles or agent handles ,i think elevenlabs mulilingual is easy choice tell me how much providers  they added hermes


second we have to make slash commands enable in our app but how these commands links to our app and works
here is docs of assistent ui for chat here is there docs about slash commands
here is docs
# Slash Commands

URL: /docs/guides/slash-commands

Trigger predefined actions in your AI chat by typing / — slash command palette with popover, search, and action handlers in React via assistant-ui.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

Slash commands let users type `/` in the composer to open a popover, browse available commands, and execute one. Unlike [mentions](/docs/guides/mentions) (which only insert a directive into the message), slash commands additionally fire an **action callback** at the moment of selection.

## How It Works

The slash command system is built on the same [trigger popover architecture](#trigger-popover-architecture) as mentions. A slash command declares its behavior with a `<TriggerPopover.Action>` sub-primitive whose `onExecute` callback fires when an item is chosen.

By default `Action` leaves a directive chip in the composer — giving the user (and the LLM) an audit trail of which commands were invoked. Pass `removeOnExecute` to strip the `/command` text entirely.

## Quick Start

### 1. Define Commands with `unstable_useSlashCommandAdapter`

Declare commands (data + `execute` bundled together, like a toolkit entry). The hook returns `{ adapter, action }` — wire both into a single `<TriggerPopover>`:

```
import {
  ComposerPrimitive,
  unstable_useSlashCommandAdapter,
  type Unstable_SlashCommand,
} from "@assistant-ui/react";

const SLASH_COMMANDS: readonly Unstable_SlashCommand[] = [
  {
    id: "summarize",
    description: "Summarize the conversation",
    execute: () => console.log("Summarize!"),
  },
  {
    id: "translate",
    description: "Translate text to another language",
    execute: () => console.log("Translate!"),
  },
  {
    id: "help",
    description: "List all available commands",
    execute: () => console.log("Help!"),
  },
];

function MyComposer() {
  const slash = unstable_useSlashCommandAdapter({ commands: SLASH_COMMANDS });

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input placeholder="Type / for commands..." />
        <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>

        <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={slash.adapter}
          className="popover"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) =>
              items.map((item, index) => (
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  className="popover-item"
                >
                  <strong>{item.label}</strong>
                  {item.description && <span>{item.description}</span>}
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              ))
            }
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
```

The label defaults to `/${id}`; override via `label` on the command. Icons are strings that your `iconMap` on the picker UI resolves to components (see [ComposerTriggerPopover](/docs/ui/composer-trigger-popover)).

### `unstable_useSlashCommandAdapter` options

| Option            | Type                            | Default | Description                                                                                                        |
| ----------------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `commands`        | `Unstable_SlashCommand[]`       | —       | Command definitions — each has `id`, optional `label`, `description`, `icon`, and an `execute` callback (required) |
| `removeOnExecute` | `boolean`                       | `false` | When `true`, strips the trigger text from the composer after executing instead of leaving a directive chip         |
| `iconMap`         | `Record<string, IconComponent>` | —       | Maps `metadata.icon` / category `id` strings to React icon components; forwarded to `ComposerTriggerPopover`       |
| `fallbackIcon`    | `IconComponent`                 | —       | Fallback when no `iconMap` entry matches; forwarded to `ComposerTriggerPopover`                                    |

The hook returns `{ adapter, action, iconMap?, fallbackIcon? }` — spread directly into `<ComposerTriggerPopover char="/" {...slash} />` for one-line wiring.

### 2. Controlling the Chip

By default, a selected `/summarize` is converted into a directive chip (`:command[/summarize]{name=summarize}`) in the composer text and the command's `execute` fires. This keeps an audit trail of which commands were invoked.

To strip the trigger text entirely — useful for purely transient commands — pass `removeOnExecute` on the hook options:

```
const slash = unstable_useSlashCommandAdapter({
  commands: SLASH_COMMANDS,
  removeOnExecute: true,
});
```

### 3. Custom Dispatch

For side effects on top of `execute` (logging, analytics, intercept), wrap the hook's `onExecute`:

```
<ComposerPrimitive.Unstable_TriggerPopover.Action
  onExecute={(item) => {
    logCommandUsed(item.id);
    slash.action.onExecute(item);
  }}
/>
```

## Categorized Commands

For **categorized navigation** (drill-down into groups), return categories from `categories()` and items from `categoryItems()`. The popover shows categories first, then items within the selected category:

```
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";

const adapter: Unstable_TriggerAdapter = {
  categories() {
    return [
      { id: "actions", label: "Actions" },
      { id: "export", label: "Export" },
    ];
  },

  categoryItems(categoryId) {
    if (categoryId === "actions") {
      return [
        { id: "summarize", type: "command", label: "/summarize", description: "Summarize the conversation" },
        { id: "translate", type: "command", label: "/translate", description: "Translate text" },
      ];
    }
    if (categoryId === "export") {
      return [
        { id: "pdf", type: "command", label: "/export pdf", description: "Export as PDF" },
        { id: "markdown", type: "command", label: "/export md", description: "Export as Markdown" },
      ];
    }
    return [];
  },

  // Optional — enables search across all categories
  search(query) {
    const lower = query.toLowerCase();
    const all = [...this.categoryItems("actions"), ...this.categoryItems("export")];
    return all.filter(
      (item) => item.label.toLowerCase().includes(lower) || item.description?.toLowerCase().includes(lower),
    );
  },
};
```

When using a categorized adapter, add `TriggerPopoverCategories` to your popover UI:

```
const commandHandlers: Record<string, () => void> = {
  summarize: () => {/* ... */},
  pdf: () => {/* ... */},
};

<ComposerPrimitive.Unstable_TriggerPopover
  char="/"
  adapter={adapter}
>
  <ComposerPrimitive.Unstable_TriggerPopover.Action
    formatter={unstable_defaultDirectiveFormatter}
    onExecute={(item) => commandHandlers[item.id]?.()}
  />
  <ComposerPrimitive.Unstable_TriggerPopoverBack>← Back</ComposerPrimitive.Unstable_TriggerPopoverBack>
  <ComposerPrimitive.Unstable_TriggerPopoverCategories>
    {(categories) => categories.map((cat) => (
      <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem key={cat.id} categoryId={cat.id}>
        {cat.label}
      </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
    ))}
  </ComposerPrimitive.Unstable_TriggerPopoverCategories>
  <ComposerPrimitive.Unstable_TriggerPopoverItems>
    {(items) => items.map((item, index) => (
      <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} index={index}>
        {item.label}
      </ComposerPrimitive.Unstable_TriggerPopoverItem>
    ))}
  </ComposerPrimitive.Unstable_TriggerPopoverItems>
</ComposerPrimitive.Unstable_TriggerPopover>
```

## Combining with Mentions

Slash commands and mentions live under the same `TriggerPopoverRoot`. Declare one `TriggerPopover` per trigger — each with its own behavior sub-primitive:

```
<ComposerPrimitive.Unstable_TriggerPopoverRoot>
  <ComposerPrimitive.Root>
    <ComposerPrimitive.Input placeholder="Type @ to mention, / for commands..." />
    <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>

    {/* @ mention popover */}
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={mention.adapter}
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive {...mention.directive} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => items.map((item) => (
          <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item}>
            {item.label}
          </ComposerPrimitive.Unstable_TriggerPopoverItem>
        ))}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>

    {/* / slash command popover */}
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={slash.adapter}
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => items.map((item, index) => (
          <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} index={index}>
            {item.label}
          </ComposerPrimitive.Unstable_TriggerPopoverItem>
        ))}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  </ComposerPrimitive.Root>
</ComposerPrimitive.Unstable_TriggerPopoverRoot>
```

Each `TriggerPopover` is its own scope — the `@` popover and the `/` popover read state from their own declaration and never collide. Keyboard events route to whichever popover is currently active.

## Commands with Arguments

Some commands accept inline arguments typed after the command word — for example `/translate en` or `/ask what is TypeScript`. Because the adapter's `search` method receives the full text after `/`, you can split on the first space to separate the command from its arguments:

```
const SLASH_COMMANDS: readonly Unstable_SlashCommand[] = [
  {
    id: "translate",
    description: "Translate to a language, e.g. /translate en",
    execute: () => {/* arguments extracted separately, see below */},
  },
  {
    id: "ask",
    description: "Ask about a topic, e.g. /ask what is TypeScript",
    execute: () => {/* arguments extracted separately, see below */},
  },
];

function MyComposer() {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const slash = unstable_useSlashCommandAdapter({
    commands: SLASH_COMMANDS.map((cmd) => ({
      ...cmd,
      execute: () => {
        // Read the full composer text to extract arguments
        const raw = composerRef.current?.value ?? "";
        // Match "/<id> <args>" at start of input
        const match = raw.match(new RegExp(`^\\/${cmd.id}\\s+(.*)`));
        const args = match?.[1]?.trim() ?? "";
        handleCommand(cmd.id, args);
      },
    })),
    removeOnExecute: true,
  });

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input ref={composerRef} placeholder="Type / for commands..." />
        <ComposerPrimitive.Unstable_TriggerPopover char="/" adapter={slash.adapter}>
          <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => items.map((item, i) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} index={i}>
                <strong>{item.label}</strong>
                {item.description && <span>{item.description}</span>}
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover>
        <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
```

`removeOnExecute: true` strips the `/translate en` text from the composer so the argument is consumed by the handler rather than sent to the LLM.

## Async Command Loading

The adapter interface is synchronous, but the command list can come from any async source. Load commands into state (or a query cache) and pass the current snapshot to the hook. Because `unstable_useSlashCommandAdapter` re-runs on every render, the adapter always reflects the latest list.

**With React state:**

```
function MyComposer() {
  const [commands, setCommands] = useState<Unstable_SlashCommand[]>([]);

  useEffect(() => {
    fetchAvailableCommands().then(setCommands);
  }, []);

  const slash = unstable_useSlashCommandAdapter({ commands });

  return (/* ... */);
}
```

**With React Query:**

```
function MyComposer() {
  const { data: commands = [] } = useQuery({
    queryKey: ["slash-commands"],
    queryFn: fetchAvailableCommands,
  });

  const slash = unstable_useSlashCommandAdapter({ commands });

  return (/* ... */);
}
```

## Keyboard Navigation

See [ComposerTriggerPopover keyboard navigation](/docs/ui/composer-trigger-popover#keyboard-navigation) for the full key bindings table.

## Trigger Popover Architecture

Both mentions and slash commands are built on a generic trigger popover system where each `Unstable_TriggerPopover` declares one trigger character, an adapter, and exactly one behavior sub-primitive (`Directive` or `Action`). Multiple triggers coexist under a single `Unstable_TriggerPopoverRoot`. See the [Composer Primitives](/docs/primitives/composer) reference for the complete API.

## Primitives Reference

See the [Composer Primitives](/docs/primitives/composer) reference for the full list of trigger popover primitives and their props.

## Related

- [Mentions Guide](/docs/guides/mentions) — `@`-mention system built on the same architecture
- [Suggestions Guide](/docs/guides/suggestions) — static follow-up prompts (different from slash commands)
- [Composer Primitives](/docs/primitives/composer) — underlying composer primitives

questions is what types of commands we uses like learn  ,overhaul etc r we can mention specific tools and skills to agent
and for mentioning we can use this docs ,i think use must ables to mentions attached skills and tools to agent 

# Mentions in Chat


URL: /docs/guides/mentions





Let users @-mention tools or custom items in the AI chat composer to guide the LLM. Mention picker built into assistant-ui's React composer.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

Mentions let users type `@` in the composer to open a popover picker, select an item (e.g. a tool), and insert a directive into the message text. The LLM can then use the directive as a hint.

## How It Works

The mention system has three layers:

1. **Trigger detection** — the composer input watches for a trigger character (`@` by default) and extracts the query
2. **Adapter** — provides the categories and items to display in the popover (e.g. registered tools)
3. **Formatter** — serializes a selected item into directive text (`:type[label]{name=id}`) and parses it back for rendering

Under the hood, mentions are one kind of [trigger popover](/docs/guides/slash-commands#trigger-popover-architecture). A mention declares its behavior with a `<TriggerPopover.Directive>` sub-primitive, which writes the formatter-serialized directive into the composer on selection.

## Quick Start

The fastest path is the pre-built [Mention UI components](/docs/ui/composer-trigger-popover), which wire everything together with two shadcn components — the popover picker and the message-side chip renderer:

With the style-aware registry configured in components.json ("@assistant-ui": "https\://r.assistant-ui.com/styles/{style}/{name}.json"), the flavor resolves from the project style automatically:

```bash
npx shadcn@latest add @assistant-ui/composer-trigger-popover @assistant-ui/directive-text
```

Or add by direct URL without registry configuration:

```bash
npx shadcn@latest add https://r.assistant-ui.com/base/composer-trigger-popover.json https://r.assistant-ui.com/base/directive-text.json
```

Or install manually:

```bash
npm install @assistant-ui/react @base-ui/react class-variance-authority
```

Then copy these source files from GitHub:

- [components/assistant-ui/composer-trigger-popover.tsx](https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/assistant-ui/composer-trigger-popover.tsx)
- [components/assistant-ui/directive-text.tsx](https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/assistant-ui/directive-text.tsx)
- [components/assistant-ui/badge.tsx](https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/assistant-ui/badge.tsx)

```bash
curl -sSL --create-dirs \
  -o components/assistant-ui/composer-trigger-popover.tsx https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/ui/src/components/assistant-ui/composer-trigger-popover.tsx \
  -o components/assistant-ui/directive-text.tsx https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/ui/src/components/assistant-ui/directive-text.tsx \
  -o components/assistant-ui/badge.tsx https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/ui/src/components/assistant-ui/badge.tsx
```

See the [Composer Trigger Popover](/docs/ui/composer-trigger-popover) and [Directive Text](/docs/ui/directive-text) guides for setup steps.

The rest of this guide covers the underlying concepts and customization points.

## Trigger Adapter

A `Unstable_TriggerAdapter` provides the data for the popover. All methods are **synchronous** — use external state management (React Query, SWR, local state) for async data, then expose loaded results through the adapter.

```
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";

const myAdapter: Unstable_TriggerAdapter = {
  categories() {
    return [
      { id: "tools", label: "Tools" },
      { id: "users", label: "Users" },
    ];
  },

  categoryItems(categoryId) {
    if (categoryId === "tools") {
      return [
        { id: "search", type: "tool", label: "Search" },
        { id: "calculator", type: "tool", label: "Calculator" },
      ];
    }
    if (categoryId === "users") {
      return [
        { id: "alice", type: "user", label: "Alice" },
        { id: "bob", type: "user", label: "Bob" },
      ];
    }
    return [];
  },

  // Optional — global search across all categories
  search(query) {
    const lower = query.toLowerCase();
    const all = [
      ...this.categoryItems("tools"),
      ...this.categoryItems("users"),
    ];
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(lower) ||
        item.id.toLowerCase().includes(lower),
    );
  },
};
```

### Async Mention Search

The built-in `unstable_useLiveCompletionAdapter` wraps an async fetcher with debouncing, stale-request cancellation (results for an outdated query are dropped), and a single-entry cache. Its `search` returns the last results synchronously and schedules a debounced fetch when the query changes; when results arrive the returned `adapter` re-creates, which re-runs the popover lookup so the fresh items render. It also reports `isLoading`, which you pass to the popover to show a loading state.

```
import {
  unstable_useLiveCompletionAdapter,
  unstable_defaultDirectiveFormatter,
} from "@assistant-ui/react";
import { ComposerTriggerPopover } from "@/components/assistant-ui/composer-trigger-popover";

function MentionPopover() {
  const mentions = unstable_useLiveCompletionAdapter({
    fetcher: async (query) => {
      const users = await fetchUsers(query);
      return users.map((u) => ({ id: u.id, type: "user", label: u.name }));
    },
  });

  return (
    <ComposerTriggerPopover
      char="@"
      adapter={mentions.adapter}
      isLoading={mentions.isLoading}
      directive={{ formatter: unstable_defaultDirectiveFormatter }}
    />
  );
}
```

The adapter interface is itself synchronous, so you can also wire async data by hand when you need a custom cache, no debounce, or an existing query client. Load results into React state (or a query cache) and read the current snapshot inside the adapter methods. The adapter re-creates on each render, so the popover always sees the latest results.

**With React state and `useEffect`:**

```
import { useState, useEffect, useMemo } from "react";
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";

function useUserMentionAdapter(query: string) {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    fetchUsers(query).then((results) => {
      if (!cancelled) setUsers(results);
    });
    return () => { cancelled = true; };
  }, [query]);

  const adapter: Unstable_TriggerAdapter = useMemo(() => ({
    categories: () => [],
    categoryItems: () => [],
    search: () =>
      users.map((u) => ({ id: u.id, type: "user", label: u.name })),
  }), [users]);

  return adapter;
}
```

`query` here is the text the user typed after `@`. You can read it from `unstable_useTriggerPopoverScopeContext` if you need it inside the component tree, or pass it as state from a controlled input.

**With React Query:**

```
import { useQuery } from "@tanstack/react-query";
import type { Unstable_TriggerAdapter } from "@assistant-ui/core";

function useMentionAdapter(query: string): Unstable_TriggerAdapter {
  const { data = [] } = useQuery({
    queryKey: ["mention-search", query],
    queryFn: () => fetchUsers(query),
    enabled: query.length > 0,
  });

  return useMemo(() => ({
    categories: () => [],
    categoryItems: () => [],
    search: () =>
      data.map((u) => ({ id: u.id, type: "user", label: u.name })),
  }), [data]);
}
```

Pass the adapter to `TriggerPopover` and declare a `Directive` sub-primitive to bind the insertion behavior:

```
import { ComposerPrimitive } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react";

<ComposerPrimitive.Unstable_TriggerPopoverRoot>
  <ComposerPrimitive.Root>
    <ComposerPrimitive.Input placeholder="Type @ to mention..." />
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={myAdapter}
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive
        formatter={unstable_defaultDirectiveFormatter}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverCategories>
        {(categories) =>
          categories.map((cat) => (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
              key={cat.id}
              categoryId={cat.id}
            >
              {cat.label}
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverCategories>
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.map((item) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              key={item.id}
              item={item}
            >
              {item.label}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  </ComposerPrimitive.Root>
</ComposerPrimitive.Unstable_TriggerPopoverRoot>
```

Exactly one behavior sub-primitive (`Directive` or `Action`) is allowed per `TriggerPopover`. The parent reads the registered behavior and wires the selection machinery.

### Built-in Mention Adapter

`unstable_useMentionAdapter` covers the common cases: mention registered tools, add your own items, mix tools with custom items, or show multi-category drill-down.

**Tools from model context (default):**

```
import { unstable_useMentionAdapter } from "@assistant-ui/react";

const mention = unstable_useMentionAdapter();
// → { adapter, directive } — spread into <ComposerTriggerPopover {...mention} />
// Default: single "Tools" category reading from toolkit registrations
```

**Custom items only (no tools):**

```
const mention = unstable_useMentionAdapter({
  items: [
    { id: "alice", type: "user", label: "Alice", icon: "User" },
    { id: "bob", type: "user", label: "Bob", icon: "User" },
  ],
});
```

**Mix custom items with model-context tools (flat):**

```
const mention = unstable_useMentionAdapter({
  items: [{ id: "kb", type: "doc", label: "Knowledge Base", icon: "Book" }],
  includeModelContextTools: true,
});
```

**Multi-category drill-down:**

```
const mention = unstable_useMentionAdapter({
  categories: [
    {
      id: "users",
      label: "Users",
      items: [
        { id: "alice", type: "user", label: "Alice", icon: "User" },
        { id: "bob", type: "user", label: "Bob", icon: "User" },
      ],
    },
    {
      id: "files",
      label: "Files",
      items: [
        { id: "readme", type: "file", label: "README.md", icon: "FileText" },
      ],
    },
  ],
  // Tools auto-appended as their own category (default id "tools", label "Tools")
  includeModelContextTools: true,
});
```

**Tool formatting and category override:**

```
const mention = unstable_useMentionAdapter({
  categories: [{ id: "users", label: "Users", items: [...] }],
  includeModelContextTools: {
    category: { id: "integrations", label: "Integrations" },
    formatLabel: (name) =>
      name.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    icon: "Wrench",
  },
});
```

**Options summary:**

| Option                     | Type                            | Behavior                                                                         |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| `items`                    | `Unstable_Mention[]`            | Flat list (ignored when `categories` is set)                                     |
| `categories`               | `{id, label, items}[]`          | Drill-down groups                                                                |
| `includeModelContextTools` | `boolean \| object`             | Default: `true` iff neither `items` nor `categories`                             |
| `formatter`                | `Unstable_DirectiveFormatter`   | Override directive serialization (default: `unstable_defaultDirectiveFormatter`) |
| `onInserted`               | `(item) => void`                | Fires after the directive is inserted into the composer                          |
| `iconMap`                  | `Record<string, IconComponent>` | Maps `metadata.icon` / category `id` strings to React components                 |
| `fallbackIcon`             | `IconComponent`                 | Fallback when no entry in `iconMap` matches                                      |

`icon` on each mention is a shortcut for `metadata.icon` that the picker UI resolves via `iconMap`. Dedup between custom items and model-context tools is by `id` — explicit items win.

The hook returns `{ adapter, directive, iconMap?, fallbackIcon? }` — spread into `<ComposerTriggerPopover {...mention} />` for one-line wiring. Callers consuming the raw primitives instead destructure: `mention.adapter`, `mention.directive.formatter`, etc.

## Directive Format

When a user selects a mention item, it is serialized into the composer text as a **directive**. The default format is:

```
:type[label]{name=id}
```

For example, selecting a tool named "get\_weather" with label "Get Weather" produces:

```
:tool[Get Weather]{name=get_weather}
```

When `id` equals `label`, the `{name=…}` attribute is omitted for brevity:

```
:tool[search]
```

### Custom Formatter

Implement `Unstable_DirectiveFormatter` to use a different format:

```
import type { Unstable_DirectiveFormatter } from "@assistant-ui/react";

const slashFormatter: Unstable_DirectiveFormatter = {
  serialize(item) {
    return `/${item.id}`;
  },

  parse(text) {
    const segments = [];
    const re = /\/(\w+)/g;
    let lastIndex = 0;
    let match;

    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ kind: "text" as const, text: text.slice(lastIndex, match.index) });
      }
      segments.push({
        kind: "mention" as const,
        type: "tool",
        label: match[1]!,
        id: match[1]!,
      });
      lastIndex = re.lastIndex;
    }

    if (lastIndex < text.length) {
      segments.push({ kind: "text" as const, text: text.slice(lastIndex) });
    }

    return segments;
  },
};
```

Pass it to the trigger's `Directive` sub-primitive and the message renderer:

```
// Composer
<ComposerPrimitive.Unstable_TriggerPopover
  char="@"
  adapter={adapter}
>
  <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={slashFormatter} />
  ...
</ComposerPrimitive.Unstable_TriggerPopover>

// User messages
const SlashDirectiveText = createDirectiveText(slashFormatter);
<MessagePrimitive.Parts components={{ Text: SlashDirectiveText }} />
```

## Textarea vs Lexical

The mention system supports two input modes:

|                                 | Textarea (default)                  | Lexical                                                    |
| ------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| **Input component**             | `ComposerPrimitive.Input`           | `LexicalComposerInput`                                     |
| **Mention display in composer** | Raw directive text (`:tool[Label]`) | Inline chips (atomic nodes)                                |
| **Dependencies**                | None                                | `@assistant-ui/react-lexical`, `lexical`, `@lexical/react` |
| **Best for**                    | Simple setups, minimal bundle       | Rich editing, polished UX                                  |

With **textarea**, selecting a mention inserts the directive string directly into the text. The user sees `:tool[Get Weather]{name=get_weather}` in the input.

With **Lexical**, selected mentions appear as styled inline chips that behave as atomic units — they can be selected, deleted, and undone as a whole. The underlying text still uses the directive format.

```
import { LexicalComposerInput } from "@assistant-ui/react-lexical";

<ComposerPrimitive.Unstable_TriggerPopoverRoot>
  <ComposerPrimitive.Root>
    <LexicalComposerInput placeholder="Type @ to mention..." />
    <ComposerPrimitive.Send />
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={adapter}
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={formatter} />
      ...
    </ComposerPrimitive.Unstable_TriggerPopover>
  </ComposerPrimitive.Root>
</ComposerPrimitive.Unstable_TriggerPopoverRoot>
```

`LexicalComposerInput` automatically discovers every `Directive` trigger registered under `TriggerPopoverRoot` and renders their selections as inline chips.

### Custom Lexical Plugins

Children of `LexicalComposerInput` render inside the `LexicalComposer` context after the built-in plugins, so standard Lexical plugin components built on `useLexicalComposerContext` work for editor concerns the mention system does not cover, such as paste normalization or length limits. Custom plugins import Lexical APIs directly, so install `lexical` and `@lexical/react` as direct dependencies of your app. The example below registers an update listener that flags messages over a maximum length.

```
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";
import { $getRoot } from "lexical";

function MaxLengthPlugin({ maxLength }: { maxLength: number }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        if ($getRoot().getTextContent().length > maxLength) {
          console.warn(`Message exceeds ${maxLength} characters`);
        }
      });
    });
  }, [editor, maxLength]);

  return null;
}

<LexicalComposerInput placeholder="Ask anything...">
  <MaxLengthPlugin maxLength={2000} />
</LexicalComposerInput>
```

## Rendering Mentions in Messages

Use `DirectiveText` as the `Text` component for user messages so directives render as inline chips instead of raw syntax. See the [Directive Text](/docs/ui/directive-text) guide for setup and customization.

## Processing Mentions on the Backend

The message text arrives at your backend with directives inline. Parse them to extract mentioned items:

```
// Default format: :type[label]{name=id}
const DIRECTIVE_RE = /:([\w-]+)\[([^\]]+)\](?:\{name=([^}]+)\})?/g;

function parseMentions(text: string) {
  const mentions = [];
  let match;
  while ((match = DIRECTIVE_RE.exec(text)) !== null) {
    mentions.push({
      type: match[1],        // e.g. "tool"
      label: match[2],       // e.g. "Get Weather"
      id: match[3] ?? match[2], // e.g. "get_weather"
    });
  }
  return mentions;
}

// Example:
// parseMentions("Use :tool[Get Weather]{name=get_weather} to check")
// → [{ type: "tool", label: "Get Weather", id: "get_weather" }]
```

You can use the extracted mentions to:

- Force-enable specific tools for the LLM call
- Add context about mentioned users or documents to the system prompt
- Log which tools users request most often

## Reading Mention State

Use `unstable_useTriggerPopoverScopeContext` inside the `TriggerPopover` to programmatically access the popover state for that trigger:

```
import { unstable_useTriggerPopoverScopeContext } from "@assistant-ui/react";

function MyPopoverContent() {
  const scope = unstable_useTriggerPopoverScopeContext();

  // scope.open — whether the popover is visible
  // scope.query — current search text after the trigger
  // scope.categories — filtered category list
  // scope.items — filtered item list
  // scope.highlightedIndex — keyboard-navigated index
  // scope.isSearchMode — true when global search is active
  // scope.selectItem(item) — programmatically select an item
  // scope.close() — close the popover

  return null;
}
```

This hook must be used inside a `ComposerPrimitive.Unstable_TriggerPopover`.

To iterate every registered trigger (e.g. from a custom input implementation), use `unstable_useTriggerPopoverTriggers` inside `TriggerPopoverRoot`.

## Building a Custom Popover

Use the trigger popover primitives to build a fully custom popover:

```
<ComposerPrimitive.Unstable_TriggerPopoverRoot>
  <ComposerPrimitive.Root>
    <ComposerPrimitive.Input />

    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={adapter}
      className="popover"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={formatter} />

      <ComposerPrimitive.Unstable_TriggerPopoverBack>
        ← Back
      </ComposerPrimitive.Unstable_TriggerPopoverBack>

      <ComposerPrimitive.Unstable_TriggerPopoverCategories>
        {(categories) =>
          categories.map((cat) => (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
              key={cat.id}
              categoryId={cat.id}
            >
              {cat.label}
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverCategories>

      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.map((item) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              key={item.id}
              item={item}
            >
              {item.label}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>

    <ComposerPrimitive.Send />
  </ComposerPrimitive.Root>
</ComposerPrimitive.Unstable_TriggerPopoverRoot>
```

### Primitives Reference

See the [Composer Primitives](/docs/primitives/composer) reference for the full list of trigger popover primitives and their props.

## Combining with Slash Commands

Mentions and slash commands coexist on the same composer. See [Combining Slash Commands and Mentions](/docs/guides/slash-commands#combining-with-mentions) for the full pattern.

## Related

- [ComposerTriggerPopover UI Component](/docs/ui/composer-trigger-popover) — pre-built shadcn component
- [DirectiveText UI Component](/docs/ui/directive-text) — renders mention chips in user messages
- [Slash Commands Guide](/docs/guides/slash-commands) — `/` command system built on the same architecture
- [Tools Guide](/docs/tools/defining-tools) — register tools that appear in the mention picker
- [Composer Primitives](/docs/primitives/composer) — underlying composer primitivesthird is main feature i think needed to engineered carefully which is first we have to give access to agent complete terminal os 
but these commands neededs to be appoved 
so we have to add human in loop type thing 
here is related docs from deepagent from langgchain and assitent ui whcih we are using in ui

# LangGraph Generative UI


URL: /docs/runtimes/langgraph/generative-ui



Render structured UI components emitted by LangGraph alongside assistant messages.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

LangGraph's [Generative UI](https://docs.langchain.com/langsmith/generative-ui-react) lets your graph emit structured UI components alongside assistant messages via `push_ui_message` (Python) or `typedUi().push()` (TypeScript). The assistant-ui adapter translates these into [`DataMessagePart`s](/docs/tools/tool-ui) on the associated assistant message, which you render with the existing `makeAssistantDataUI` API.

## Enable the `custom` stream mode

UI messages are emitted through LangGraph's `custom` stream channel. Make sure your `sendMessage` helper includes `"custom"` in `streamMode`:

```
streamMode: ["messages", "updates", "custom"];
```

If your graph accumulates UI messages in state under the `ui` key (the default for `typedUi`), `"values"` also works; the adapter reads both paths.

## Custom state key

If your graph uses a non-default `stateKey` with `typedUi(config, { stateKey: "my_ui" })` on the server, pass the matching `uiStateKey` option to `useLangGraphRuntime`:

```
const runtime = useLangGraphRuntime({
  stream: async function* (messages, { initialize }) {
    /* ... */
  },
  uiStateKey: "my_ui",
});
```

This only affects the `values` stream path; the `custom` channel carries each UI event individually and does not rely on the state key.

## Emit a UI message from your graph

Choose one:

**Python**

```
from langgraph.graph.ui import push_ui_message
from langchain_core.messages import AIMessage

async def chart_node(state, config):
    message = AIMessage(id="msg-1", content="Here's your chart.")
    push_ui_message(
        "chart",
        {"series": [1, 2, 3], "title": "Sales"},
        message=message,  # Links the UI to this AI message
    )
    return {"messages": [message]}
```

**TypeScript**

```
import { typedUi } from "@langchain/langgraph-sdk/react-ui/server";
import type { ComponentRegistry } from "./components";

export async function chartNode(state, config) {
  const ui = typedUi<ComponentRegistry>(config);
  const message = { id: "msg-1", type: "ai", content: "Here's your chart." };
  ui.push(
    { name: "chart", props: { series: [1, 2, 3], title: "Sales" } },
    { message },
  );
  return { messages: [message] };
}
```

Passing `message` (Python) or `{ message }` (TypeScript) is what links the UI component to a specific assistant message. The adapter reads `metadata.message_id` to attach the generated `DataMessagePart` to the correct message in the thread.

## Register a renderer on the client

**React**

```
import { makeAssistantDataUI } from "@assistant-ui/react";

type ChartProps = {
  series: number[];
  title: string;
};

export const ChartUI = makeAssistantDataUI<ChartProps>({
  name: "chart",
  render: ({ data }) => (
    <div>
      <h3>{data.title}</h3>
      <Chart series={data.series} />
    </div>
  ),
});
```

Mount the component once somewhere inside the `AssistantRuntimeProvider` tree. It renders nothing itself; it only registers the renderer:

**React**

```
<AssistantRuntimeProvider runtime={runtime}>
  <ChartUI />
  <Thread />
</AssistantRuntimeProvider>
```

When a matching UI message arrives, the adapter appends a `{ type: "data", name: "chart", data: { series, title } }` part to the parent assistant message and the registered component renders inline.

## Register renderers via `uiComponents`

Instead of mounting separate `makeAssistantDataUI` components, register renderers directly on the runtime hook:

```
const runtime = useLangGraphRuntime({
  stream: async function* (messages, { initialize }) {
    /* ... */
  },
  uiComponents: {
    renderers: {
      chart: ({ data }) => <Chart series={data.series} title={data.title} />,
      table: ({ data }) => <DataTable rows={data.rows} />,
    },
  },
});
```

Static `renderers` are matched by `ui_message` name. If no match is found, the part renders nothing unless a `fallback` is provided.

## Dynamic loading with `fallback`

LangSmith's [Generative UI](https://docs.langchain.com/langsmith/generative-ui-react) supports colocating UI code with your graph and loading it at runtime via `LoadExternalComponent`. The `fallback` option handles any `ui_message` name that has no static renderer:

```
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";

const runtime = useLangGraphRuntime({
  stream: async function* (messages, { initialize }) {
    /* ... */
  },
  uiComponents: {
    fallback: ({ name, data }) => (
      <LoadExternalComponent name={name} props={data} />
    ),
    renderers: {
      chart: ({ data }) => <Chart {...data} />,
    },
  },
});
```

With this setup:

- A `ui_message` with `name: "chart"` renders the static `Chart` component.
- Any other name (e.g. `"dashboard"`, `"form"`) is handled by `fallback`, which fetches the component from LangSmith at runtime.

`fallback` receives the same props as any data renderer: `name`, `data`, and part state metadata.

## Semantics

The adapter mirrors the reducer in `@langchain/langgraph-sdk/react-ui` exactly:

- UI messages are keyed by their own `id`. Pushing the same id again **replaces** the existing entry.
- Passing `metadata: { merge: true }` shallow-merges `props` onto the previous entry.
- Emitting `{ type: "remove-ui", id }` (via `delete_ui_message` or `ui.delete(id)`) removes the entry.
- UI messages without `metadata.message_id` are held in the runtime but not injected into any message; use `useLangGraphUIMessages()` to access the raw list if needed.

## Restore persisted UI messages on thread switch

If your graph persists UI messages in state via `typedUi`, return them from the `load` callback so they are restored when the user switches threads or refreshes the page:

```
const runtime = useLangGraphRuntime({
  stream: async function* (messages, { initialize }) {
    /* ... */
  },
  load: async (externalId) => {
    const state = await getThreadState(externalId);
    return {
      messages: state.values.messages,
      uiMessages: state.values.ui,
      interrupts: state.tasks[0]?.interrupts,
    };
  },
});
```

Without this, each reload starts with an empty UI list even though the messages themselves are loaded.

## Escape hatch: `useLangGraphUIMessages`

```
import { useLangGraphUIMessages } from "@assistant-ui/react-langgraph";

function Sidebar() {
  const uiMessages = useLangGraphUIMessages();
  // Filter, group, or render UI messages outside the thread
  return <>{uiMessages.map(/* ... */)}</>;
}
```

## Related

- [Streaming](/docs/runtimes/langgraph/streaming) — Event handlers, message accumulator, conversion, metadata.
- [Interrupts](/docs/runtimes/langgraph/interrupts) — Interrupt persistence and checkpoint-based message editing.
- [Threads](/docs/runtimes/langgraph/threads) — Basic thread support, AssistantCloud, custom thread list adapter.

# LangGraph UI Runtime
URL: /docs/runtimes/langgraph/overview

Build a chat UI for LangGraph agents in React with assistant-ui — streaming, subgraph events, UI messages, interrupts, and end-to-end cancellation supported.

> For AI agents: a documentation index is available at [llms.txt](/llms.txt). Use `.md` for canonical markdown pages; `.mdx` is kept as a backwards-compatible alias on supported URL paths.

`@assistant-ui/react-langgraph` integrates with [`@langchain/langgraph-sdk`](https://docs.langchain.com/oss/javascript/langgraph-sdk) directly, exposing the full LangGraph Cloud feature set in assistant-ui: streaming, subgraph events, UI messages, message metadata, interrupts, and end-to-end cancellation.

> [!info]
>
> **Migrating from LangServe?** LangChain has deprecated `RemoteRunnable` upstream and consolidated the chain and agent execution stories under LangGraph. Rebuild your chain as a LangGraph graph (LangChain's [LangServe → LangGraph migration guide](https://github.com/langchain-ai/langserve/blob/main/MIGRATION.md) covers the shape change), deploy via LangGraph Cloud or self-host LangGraph Studio, and use this runtime on the frontend. The runtime ships streaming, interrupts, generative UI, message metadata, and end-to-end cancellation out of the box.

## When to use it

Pick the LangGraph runtime when:

- You have (or want) a LangGraph Cloud server, locally via [LangGraph Studio](https://docs.langchain.com/langsmith/quick-start-studio) or hosted via [LangSmith](https://www.langchain.com/langsmith).
- Your graph state has a `messages` key with LangChain-alike messages.
- You want generative UI (`ui_message`), per-message metadata, subgraph events, or checkpoint-based message editing.

> [!info]
>
> If you are already using `@langchain/react`'s `useStream` hook, the alternative [`@assistant-ui/react-langchain`](/docs/runtimes/langchain) adapter may fit better. It delegates the stream plumbing to the upstream hook; the feature surface differs, see [LangChain useStream](/docs/runtimes/langchain) for the comparison table.

## Architecture

`@assistant-ui/react-langgraph` is layered on `ExternalStoreRuntime` (see [architecture](/docs/runtimes/concepts/architecture)). Graph state is the source of truth; the runtime renders messages from `state.values.messages` and submits user input back to the graph.

Shared adapters (attachments, speech, feedback, history) work the same way described in [adapters](/docs/runtimes/concepts/adapters).

## Requirements

- A LangGraph Cloud API server.
- React 18 or 19.
- The graph state must include a `messages` key with LangChain-alike messages.

## Install

**React**

```bash
npm install @assistant-ui/react @assistant-ui/react-langgraph @langchain/langgraph-sdk
```

## Next

- [Quickstart](/docs/runtimes/langgraph/quickstart) — From-template and manual setup paths to a working LangGraph chat.
- [Streaming](/docs/runtimes/langgraph/streaming) — Event handlers, message metadata, generative UI.
- [Interrupts](/docs/runtimes/langgraph/interrupts) — Interrupt persistence and checkpoint-based message editing.
- [Threads](/docs/runtimes/langgraph/threads) — Basic thread support, AssistantCloud, custom thread list adapter.
- [Tutorial: Stockbroker](/docs/runtimes/langgraph/tutorial/introduction) — End-to-end stockbroker assistant with generative UI and approval flows.
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.langchain.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Permissions

> Control filesystem access with declarative permission rules for Deep Agents

Control which files and directories an agent can read or write to using declarative permission rules. Pass a list of rules to `permissions=` and the agent's built-in filesystem tools respect them.

<Note>
  Permissions require `deepagents>=0.5.2`.
</Note>

Permissions only apply to the built-in filesystem tools (`ls`, `read_file`, `glob`, `grep`, `write_file`, `edit_file`, `delete`). Custom tools and MCP tools that access the filesystem are not covered. Permissions also do not apply to [sandbox backends](/oss/python/deepagents/sandboxes), which support arbitrary command execution via the `execute` tool.

<Tip>
  Use `permissions` when you need **path-based allow/deny rules** on the built-in filesystem tools. Use [backend policy hooks](/oss/python/deepagents/backends#add-policy-hooks) when you need custom validation logic (rate limiting, audit logging, content inspection) or need to control custom tools.
</Tip>

## Basic usage

Pass a list of [`FilesystemPermission`](https://reference.langchain.com/python/deepagents/middleware/permissions/FilesystemPermission) rules to [`create_deep_agent`](https://reference.langchain.com/python/deepagents/graph/create_deep_agent). Rules are evaluated in declaration order. The first matching rule wins. If no rule matches, the operation is allowed.

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
from deepagents import FilesystemPermission, create_deep_agent


# Read-only agent: deny all writes
agent = create_deep_agent(
    model=model,
    backend=backend,
    permissions=[
        FilesystemPermission(
            operations=["write"],
            paths=["/**"],
            mode="deny",
        ),
    ],
)
```

## Rule structure

Each `FilesystemPermission` has three fields:

| Field        | Type                               | Description                                                                                                                                                   |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations` | `list["read" \| "write"]`          | Operations this rule applies to. `"read"` covers `ls`, `read_file`, `glob`, `grep`. `"write"` covers `write_file`, `edit_file`, `delete`.                     |
| `paths`      | `list[str]`                        | Glob patterns for matching file paths (e.g., `["/workspace/**"]`). Supports `**` for recursive matching and `{a,b}` for alternation.                          |
| `mode`       | `"allow" \| "deny" \| "interrupt"` | Whether to allow, deny, or pause for human approval on matching operations. Defaults to `"allow"`. See [Pause for human approval](#pause-for-human-approval). |

Rules use first-match-wins evaluation: the first rule whose `operations` and `paths` match the current call determines the outcome. If no rule matches, the call is **allowed** (permissive default).

## Pause for human approval

<Note>
  The `"interrupt"` mode requires `deepagents>=0.6.8`.
</Note>

Set `mode="interrupt"` to pause for human approval instead of allowing or denying a matching operation outright. When the agent calls a built-in write tool (`write_file`, `edit_file`, `delete`) on a path that matches an interrupt-mode rule, `create_deep_agent` raises a human-in-the-loop interrupt rather than running the tool, and a reviewer can approve, edit, or reject the call.

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
from deepagents import FilesystemPermission, create_deep_agent
from langgraph.checkpoint.memory import InMemorySaver

agent = create_deep_agent(
    model=model,
    permissions=[
        # Pause for approval before writing anything under /secrets.
        FilesystemPermission(
            operations=["write"],
            paths=["/secrets/**"],
            mode="interrupt",
        ),
    ],
    # Interrupt mode requires a checkpointer to pause and resume.
    checkpointer=InMemorySaver(),
)
```

Interrupt-mode rules are wired into the agent's human-in-the-loop middleware automatically and merge with any `interrupt_on` you pass, so you handle and resume them the same way as tool-call interrupts. See [Human-in-the-loop](/oss/python/deepagents/human-in-the-loop) for the resume flow.

<Note>
  Deleting a directory is all-or-nothing: `delete` checks the `write` permission on the target and every descendant path, and refuses the entire operation if any of them is denied, rather than removing part of the tree. `delete` applies this same conservative check to an existing empty directory, since it is still a directory rather than a confirmed leaf target.

  Deleting a plain file is an exact-match case instead: `delete` resolves the target the same way `write_file` and `edit_file` do, using first-match-wins evaluation, so an earlier, narrower `allow` rule wins over a later catch-all `deny`. `deepagents>=0.7.3` is required for this exact-match behavior.
</Note>

<Tip>
  Anchor interrupt patterns with a literal leading segment (for example, `/secrets/**` or `/projects/*/secrets/**`). Bulk tools (`ls`, `glob`, `grep`, and `delete` on a directory) fire the interrupt when their search subtree could overlap the rule's anchored prefix, so a fully unanchored pattern like `/**/secrets` conservatively over-fires.
</Tip>

## Examples

### Isolate to a workspace directory

Allow reads and writes only under `/workspace/` and deny everything else:

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
agent = create_deep_agent(
    model=model,
    backend=backend,
    permissions=[
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/workspace/**"],
            mode="allow",
        ),
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/**"],
            mode="deny",
        ),
    ],
)
```

### Protect specific files

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
agent = create_deep_agent(
    model=model,
    backend=backend,
    permissions=[
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/workspace/.env", "/workspace/examples/**"],
            mode="deny",
        ),
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/workspace/**"],
            mode="allow",
        ),
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/**"],
            mode="deny",
        ),
    ],
)
```

### Read-only memory

Allow the agent to read memory files but prevent it from modifying them. This is useful for organization-wide policies or shared knowledge bases that should only be updated by application code. See [read-only vs writable memory](/oss/python/deepagents/memory#read-only-vs-writable-memory) for more context.

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend

agent = create_deep_agent(
    model=model,
    backend=CompositeBackend(
        default=StateBackend(),
        routes={
            "/memories/": StoreBackend(
                namespace=lambda rt: (rt.server_info.user.identity,),
            ),
            "/policies/": StoreBackend(
                namespace=lambda rt: (rt.context.org_id,),
            ),
        },
    ),
    permissions=[
        FilesystemPermission(
            operations=["write"],
            paths=["/memories/**", "/policies/**"],
            mode="deny",
        ),
    ],
)
```

### Deny all access

Block all reads and writes. This is a restrictive baseline you can layer more specific allow rules on top of:

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
agent = create_deep_agent(
    model=model,
    backend=backend,
    permissions=[
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/**"],
            mode="deny",
        ),
    ],
)
```

### Rule ordering

Because of first-match-wins, rule order matters. Place more specific rules before broader ones:

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
# Correct: deny .env, allow workspace, deny everything else
correct_permissions = [
    FilesystemPermission(
        operations=["read", "write"],
        paths=["/workspace/.env"],
        mode="deny",
    ),
    FilesystemPermission(
        operations=["read", "write"],
        paths=["/workspace/**"],
        mode="allow",
    ),
    FilesystemPermission(
        operations=["read", "write"],
        paths=["/**"],
        mode="deny",
    ),
]

# Bug: /workspace/** matches .env first, so the deny never triggers
incorrect_permissions = [
    FilesystemPermission(
        operations=["read", "write"],
        paths=["/workspace/**"],
        mode="allow",
    ),
    FilesystemPermission(
        operations=["read", "write"],
        paths=["/workspace/.env"],
        mode="deny",  # never reached
    ),
    FilesystemPermission(
        operations=["read", "write"],
        paths=["/**"],
        mode="deny",
    ),
]
```

## Subagent permissions

[Subagents](/oss/python/deepagents/subagents) inherit the parent agent's permissions by default. To give a subagent different permissions, set the `permissions` field in its spec. This **replaces** the parent's rules entirely.

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
agent = create_deep_agent(
    model=model,
    backend=backend,
    permissions=[
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/workspace/**"],
            mode="allow",
        ),
        FilesystemPermission(
            operations=["read", "write"],
            paths=["/**"],
            mode="deny",
        ),
    ],
    subagents=[
        {
            "name": "auditor",
            "description": "Read-only code reviewer",
            "system_prompt": "Review the code for issues.",
            "permissions": [
                FilesystemPermission(
                    operations=["write"],
                    paths=["/**"],
                    mode="deny",
                ),
                FilesystemPermission(
                    operations=["read"],
                    paths=["/workspace/**"],
                    mode="allow",
                ),
                FilesystemPermission(
                    operations=["read"],
                    paths=["/**"],
                    mode="deny",
                ),
            ],
        }
    ],
)
```

## Composite backends

When using a [`CompositeBackend`](https://reference.langchain.com/python/deepagents/backends/composite/CompositeBackend) with a sandbox default, every permission path must be scoped under a known route prefix. Sandboxes support arbitrary command execution, so path-based restrictions alone cannot prevent filesystem access through shell commands. Scoping permissions to route-specific [backends](/oss/python/deepagents/backends) avoids this conflict.

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
from deepagents.backends import CompositeBackend


composite = CompositeBackend(
    default=sandbox,
    routes={"/memories/": memories_backend},
)

# Works: permissions are scoped to the /memories/ route
agent = create_deep_agent(
    model=model,
    backend=composite,
    permissions=[
        FilesystemPermission(
            operations=["write"],
            paths=["/memories/**"],
            mode="deny",
        ),
    ],
)
```

Permissions that include paths outside any route raise `NotImplementedError`:

```python theme={"theme":{"light":"catppuccin-latte","dark":"catppuccin-mocha"}}
# Raises NotImplementedError: /workspace/** hits the sandbox default
try:
    create_deep_agent(
        model=model,
        backend=composite,
        permissions=[
            FilesystemPermission(
                operations=["write"],
                paths=["/workspace/**"],
                mode="deny",
            ),
        ],
    )
except NotImplementedError:
    pass

# Also raises: /** covers both routes and the default
try:
    create_deep_agent(
        model=model,
        backend=composite,
        permissions=[
            FilesystemPermission(
                operations=["read"],
                paths=["/**"],
                mode="deny",
            ),
        ],
    )
except NotImplementedError:
    pass
```

***

<div className="source-links">
  <Callout icon="terminal-2">
    [Connect these docs](/use-these-docs) to Claude, VSCode, and more via MCP for real-time answers.
  </Callout>

  <Callout icon="edit">
    [Edit this page on GitHub](https://github.com/langchain-ai/docs/edit/main/src/oss/deepagents/permissions.mdx) or [file an issue](https://github.com/langchain-ai/docs/issues/new/choose).
  </Callout>
</div>
https://docs.langchain.com/oss/python/deepagents/human-in-the-loop
this is link of loop 

i wants in this ui generation 
wants human in loop 
plan all these three features with deep level details
make plan