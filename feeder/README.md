# Feeder Backend

Runs the article ingestion + deduplication pipeline once per trigger
(`python -m feeder.pipeline --workflow-id <id> [--user-id <id>]`).

## Fetch-time normalization (`feeder/feed_clean.py`)

Google News RSS carries **no real descriptions** — the summary is HTML junk
(redirect URLs + the repeated title). At the door we therefore:

- strip Google's trailing ` - <Source>` title suffix (tolerating messy
  separators like `- | Associated Press Of Pakistan`)
- store `description = ""` instead of HTML junk (keeps hashes/prompts clean);
  feeds with real summaries keep their plain text
- extract **cluster sibling titles** from the summary HTML — Google News' own
  editorial clustering, used as a free same-story signal by Layer 0 and shown
  to the dedup agent as a hint

## Layers, in order

- **Time filter** — drops articles older than the workflow's time window
  (`feeder_max_age_minutes`)
- **Domain whitelist** — keeps only trusted domains (empty list = allow all)
- **Event clustering** — fuzzy title match (fixed normalization that preserves
  whitespace) + sibling-cluster match; groups same-event headlines, keeps
  best-trusted source
- **Run cap** — keeps at most the workflow's `feeder_max_articles_per_run`
  (default 100, max 500)
- **GUID check** — never re-delivers an already seen feed item
- **Hash check** — SHA-256 of the **normalized title** (lowercase, punctuation
  stripped, source suffix removed): identical wire headlines collide across
  outlets even when URLs/descriptions differ
- **Feeder Dedup Agent (Pass 1)** — LLM call (provider/model resolved from the user's
  `agent_settings`) that dedups by **developing storyline**, not just event:
  reactions/condolences/inquiries/fallout of the same incident are ONE
  storyline → one survivor. Chunked at 40 articles; each chunk also sees the
  titles kept by earlier chunks so cross-chunk duplicates are caught.
  **DROP-ONLY contract**: the model only lists drops — everything else is kept.
  (Heavy contracts with full kept-lists + mandatory ID coverage let weaker
  models take a `keep=[all]` shortcut without doing Phase 1 at all — observed
  in production with multiple models.) The pipeline also pre-computes
  **suspected duplicate pairs** (Layer-0 similarity band 40-69% + Google
  sibling matches) and hands them to the agent to confirm/reject, so the LLM
  judges candidates instead of discovering clusters cold.
  **Fail-open**: on LLM failure or missing IDs, articles are KEPT, never lost.
  Phase 2 has a **major-development exception**: a stored minor angle
  (condolence/reaction) must not block the main report or the next big chapter.
- **Feeder Verifier Agent (Pass 2)** — a second, INDEPENDENT LLM (own
  provider/model via `feeder_verifier_provider` / `feeder_verifier_model`
  in agent_settings, editable per user in Feeder Settings → AI) that reviews
  ALL Pass-1 survivors at once with **drop-only authority**. Catches misses,
  cross-chunk leftovers and Pass-1 bad days (e.g. model replying "keep all").
  Can only shrink the kept set, so the two passes converge instead of
  oscillating. Same major-development exception + a "dropping everything =
  you're matching topics, not storylines" sanity check (both added after
  observed over-aggressive verdicts). Toggle: `feeder_verifier_enabled`
  (default true).

Nothing is written to the database during checks; surviving articles are
stored atomically at the end with status `Pending`.

## Run history / logs

Every run writes one row to `feeder_run_history`:

- `layer_stats` — funnel counts (fetched → after_time → after_domain →
  after_cluster → after_guid_hash → after_agent → after_verifier → stored)
- `drop_log` — **every** dropped article with `{layer, title, domain, reason}`
- `kept_log` — every stored article
- `storylines` — the agent's storyline clusters
- `status` / `error` — failed runs are recorded too

The Feeder Dashboard UI shows these under **Pipeline Run History**.

## Settings precedence

`defaults < feeder_settings (global) < agent_settings (per user) < workflows.feeder_* (per workflow)`

Per-workflow columns: `feeder_enabled`, `feeder_interval_minutes`,
`feeder_max_age_minutes`, `feeder_max_articles_per_run`,
`feeder_cluster_threshold` — all editable under Feeder Settings in the UI.
