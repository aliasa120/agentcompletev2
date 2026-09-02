# Feeder Frontend

- `/feeder` — workflow-scoped dashboard: article stats, pending queue, manual run.
- `/feeder/settings` — overview + sub-pages:
  - `sources/` — RSS sources CRUD + guided Google News feed builder
  - `filters/` — per-workflow time window, max articles/run, cluster threshold, whitelisted domains
  - `schedule/` — per-workflow auto-run toggle + interval (single source of truth)
  - `ai/` — per-user feeder dedup LLM provider/model
  - `data/` — table inspection, clearing, danger zone
- `_components/` — shared UI bits (StatCard, PresetButton, SectionCard, helpers)
