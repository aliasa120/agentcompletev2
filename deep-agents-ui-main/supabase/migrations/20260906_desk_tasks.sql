-- =============================================================================
-- Migration: desk_tasks (Add to Desk)
-- Purpose: Agent-created task cards waiting on the user's Desk for one-click
--          review/execution. Instead of executing sensitive actions (emails,
--          publishing, sends) directly, the agent deposits a task card here
--          with editable arguments + action buttons bound to tool schemas.
--          The user reviews, edits arguments in the card, and executes with
--          a single click — no mid-chat approval flow needed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.desk_tasks (
  id                UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           UUID    NOT NULL,

  -- Origin context: where the task came from (files live in this thread)
  thread_id         TEXT    NOT NULL,
  workflow_id       TEXT,
  agent_id          TEXT,

  -- Card content
  title             TEXT    NOT NULL,
  summary           TEXT,             -- what the agent prepared / did
  user_prompt       TEXT,             -- the original user request that initiated the task

  -- Lifecycle: 'pending' | 'executing' | 'done' | 'failed'
  -- ('rejected' cards are deleted along with their files)
  status            TEXT    NOT NULL DEFAULT 'pending',

  -- UI spec: editable argument fields placed on the card
  -- [ { name, label, type: text|textarea|number|select|readonly, value,
  --     required, options, arg_key, help } ]
  fields            JSONB   NOT NULL DEFAULT '[]'::jsonb,

  -- Action buttons: each execute button is bound to a tool schema/args
  -- [ { id, label, kind: execute|cancel, style, tool_name, tool_type,
  --     args, description } ]
  buttons           JSONB   NOT NULL DEFAULT '[]'::jsonb,

  -- Files produced while preparing the task (relative to thread workspace)
  -- [ { path, name, kind } ]
  files             JSONB   NOT NULL DEFAULT '[]'::jsonb,

  result            TEXT,
  error             TEXT,
  executed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS desk_tasks_user_status_idx
  ON public.desk_tasks (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS desk_tasks_thread_idx
  ON public.desk_tasks (thread_id);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_desk_tasks_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS desk_tasks_updated_at ON public.desk_tasks;
CREATE TRIGGER desk_tasks_updated_at
  BEFORE UPDATE ON public.desk_tasks
  FOR EACH ROW EXECUTE FUNCTION update_desk_tasks_timestamp();

-- RLS: users see/manage only their own desk; backend (service_role) bypasses RLS
ALTER TABLE public.desk_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own desk tasks"
  ON public.desk_tasks
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own desk tasks"
  ON public.desk_tasks
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own desk tasks"
  ON public.desk_tasks
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own desk tasks"
  ON public.desk_tasks
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Realtime so the Desk inbox updates live while the agent works
ALTER PUBLICATION supabase_realtime ADD TABLE public.desk_tasks;

COMMENT ON TABLE public.desk_tasks IS
  'Add to Desk: task cards deposited by agents for one-click user execution. '
  'fields = editable arguments, buttons = actions bound to tool schemas '
  '(cancel buttons have no schema — the card and its thread files are deleted).';

-- Default-on: add_to_desk is non-destructive (it only deposits cards), so
-- enable it for every main agent that doesn't already have an assignment.
ALTER TABLE public.agent_tool_assignments
  ADD COLUMN IF NOT EXISTS loading_mode TEXT;

INSERT INTO agent_tool_assignments (agent_id, tool_type, tool_key, tool_label, enabled, loading_mode)
SELECT c.id, 'builtin', 'add_to_desk', 'Add to Desk', true, 'primary'
FROM agent_configs c
WHERE c.agent_type = 'main'
  AND NOT EXISTS (
    SELECT 1 FROM agent_tool_assignments a
    WHERE a.agent_id = c.id AND a.tool_key = 'add_to_desk'
  );
