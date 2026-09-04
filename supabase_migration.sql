
-- ============================================================
-- Deep Agents — Full Database Migration (Workspace Segregation)
-- Run this in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension (usually already enabled)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── user_settings ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_settings (
  id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  composio_api_key  TEXT DEFAULT '',
  appearance        JSONB DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS appearance JSONB DEFAULT '{}'::jsonb;

-- ── workflows ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  enabled         BOOLEAN DEFAULT true,
  interval_minutes INTEGER DEFAULT 30,
  batch_size      INTEGER DEFAULT 2,
  last_trigger_at TIMESTAMPTZ,
  feeder_enabled  BOOLEAN DEFAULT true,
  feeder_interval_minutes INTEGER DEFAULT 30,
  feeder_last_trigger_at TIMESTAMPTZ,
  feeder_max_age_minutes INTEGER DEFAULT 60,
  feeder_max_articles_per_run INTEGER DEFAULT 100,
  feeder_cluster_threshold INTEGER DEFAULT 70,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT workflows_user_name_unique UNIQUE (user_id, name)
);

-- ── agent_configs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  agent_type    TEXT NOT NULL DEFAULT 'subagent',
  description   TEXT DEFAULT '',
  system_prompt TEXT DEFAULT '',
  model_key     TEXT DEFAULT 'main_agent',
  enabled       BOOLEAN DEFAULT true,
  sort_order    INTEGER DEFAULT 0,
  is_builtin    BOOLEAN DEFAULT false,
  provider      TEXT DEFAULT 'vercel',
  model         TEXT DEFAULT 'xiaomi/mimo-v2.5-pro',
  workflow_id   UUID REFERENCES workflows(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- ── agent_tool_assignments ───────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_tool_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
  tool_type   TEXT NOT NULL,
  tool_key    TEXT NOT NULL,
  tool_label  TEXT DEFAULT '',
  enabled     BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_id, tool_key)
);

-- ── mcp_connections ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mcp_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_type   TEXT NOT NULL DEFAULT 'manual',
  toolkit_slug      TEXT DEFAULT '',
  label             TEXT NOT NULL,
  mcp_url           TEXT DEFAULT '',
  composio_conn_id  TEXT,
  status            TEXT DEFAULT 'active',
  available_tools   JSONB DEFAULT '[]',
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT mcp_connections_user_composio_conn_unique UNIQUE (user_id, composio_conn_id)
);

-- ── skills_library ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills_library (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  skill_key   TEXT NOT NULL,
  label       TEXT NOT NULL,
  description TEXT DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  source      TEXT DEFAULT 'user',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT skills_library_user_skill_key_unique UNIQUE (user_id, skill_key)
);

-- ── design_assets ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS design_assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  asset_key   TEXT NOT NULL,
  label       TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT design_assets_user_asset_key_unique UNIQUE (user_id, asset_key)
);

-- Brand asset folders and R2-backed asset metadata
CREATE TABLE IF NOT EXISTS design_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT design_folders_user_name_unique UNIQUE (user_id, name)
);

ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS folder_id       UUID REFERENCES design_folders(id) ON DELETE SET NULL;
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS media_type      TEXT DEFAULT 'image';
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS mime_type       TEXT DEFAULT '';
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS storage_backend TEXT DEFAULT 'local_legacy';
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS storage_key      TEXT DEFAULT '';
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS public_url      TEXT;
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS size_bytes      BIGINT;
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS source          TEXT DEFAULT 'upload';
ALTER TABLE design_assets ADD COLUMN IF NOT EXISTS sort_order      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE design_assets ALTER COLUMN file_path DROP NOT NULL;

CREATE TABLE IF NOT EXISTS agent_design_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
  folder_id   UUID NOT NULL REFERENCES design_folders(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_id, folder_id)
);

CREATE TABLE IF NOT EXISTS provider_design_assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_slug   TEXT NOT NULL,
  design_asset_id UUID NOT NULL REFERENCES design_assets(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(provider_slug, design_asset_id)
);

INSERT INTO design_folders (user_id, name, description, sort_order)
SELECT DISTINCT user_id, 'Legacy Brand Assets', 'Assets imported from the previous flat library', 999
FROM design_assets
WHERE user_id IS NOT NULL
ON CONFLICT (user_id, name) DO NOTHING;

UPDATE design_assets da
SET folder_id = df.id
FROM design_folders df
WHERE da.folder_id IS NULL
  AND df.user_id IS NOT DISTINCT FROM da.user_id
  AND df.name = 'Legacy Brand Assets';

CREATE INDEX IF NOT EXISTS idx_design_assets_folder ON design_assets(folder_id);
CREATE INDEX IF NOT EXISTS idx_design_assets_user ON design_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_design_folders_agent ON agent_design_folders(agent_id);

-- ── telegram_chat_bindings ──────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_chat_bindings (
  chat_id     TEXT,
  workflow_id UUID REFERENCES workflows(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (chat_id, workflow_id)
);

-- ── telegram_bots ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_bots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_token   TEXT NOT NULL UNIQUE,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ── agent_scheduled_tasks ────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_scheduled_tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  prompt              TEXT,
  skills              JSONB DEFAULT '[]',
  model               TEXT,
  provider            TEXT,
  base_url            TEXT,
  script              TEXT,
  no_agent            BOOLEAN DEFAULT false,
  context_from        JSONB DEFAULT '[]',
  schedule            JSONB NOT NULL,
  schedule_display    TEXT NOT NULL,
  repeat_times        INTEGER,
  repeat_completed    INTEGER DEFAULT 0,
  enabled             BOOLEAN DEFAULT true,
  state               TEXT DEFAULT 'scheduled',
  paused_at           TIMESTAMPTZ,
  paused_reason       TEXT,
  deliver             TEXT DEFAULT 'local',
  origin              JSONB DEFAULT '{}',
  enabled_toolsets    JSONB DEFAULT '[]',
  workdir             TEXT,
  timezone            TEXT,
  mount_chat          TEXT,
  context_summary     TEXT,
  last_run_at         TIMESTAMPTZ,
  last_run_logs       TEXT,
  last_status         TEXT,
  last_error          TEXT,
  next_run_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);
-- Enhancements: per-task timezone + chat context mounting (idempotent for existing installs)
ALTER TABLE agent_scheduled_tasks ADD COLUMN IF NOT EXISTS timezone        TEXT;
ALTER TABLE agent_scheduled_tasks ADD COLUMN IF NOT EXISTS mount_chat      TEXT;
ALTER TABLE agent_scheduled_tasks ADD COLUMN IF NOT EXISTS context_summary TEXT;

-- ── RLS: Enable RLS on all tables for workspace isolation ──
ALTER TABLE workflows              ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections        ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills_library         ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_assets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_folders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_design_folders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_chat_bindings  DISABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_bots           ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_scheduled_tasks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings          ENABLE ROW LEVEL SECURITY;

-- ── RLS Policies ──
DROP POLICY IF EXISTS user_workflows_policy ON workflows;
CREATE POLICY user_workflows_policy ON workflows 
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_agent_configs_policy ON agent_configs;
CREATE POLICY user_agent_configs_policy ON agent_configs 
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_mcp_connections_policy ON mcp_connections;
CREATE POLICY user_mcp_connections_policy ON mcp_connections 
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_skills_library_policy ON skills_library;
CREATE POLICY user_skills_library_policy ON skills_library 
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_design_assets_policy ON design_assets;
CREATE POLICY user_design_assets_policy ON design_assets 
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_scheduled_tasks_policy ON agent_scheduled_tasks;
CREATE POLICY user_scheduled_tasks_policy ON agent_scheduled_tasks 
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_telegram_bots_policy ON telegram_bots;
CREATE POLICY user_telegram_bots_policy ON telegram_bots
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_settings_policy ON user_settings;
CREATE POLICY user_settings_policy ON user_settings;
CREATE POLICY user_settings_policy ON user_settings
  FOR ALL TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS user_agent_tool_assignments_policy ON agent_tool_assignments;
CREATE POLICY user_agent_tool_assignments_policy ON agent_tool_assignments
  FOR ALL TO authenticated 
  USING (EXISTS (SELECT 1 FROM agent_configs WHERE agent_configs.id = agent_tool_assignments.agent_id AND agent_configs.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM agent_configs WHERE agent_configs.id = agent_tool_assignments.agent_id AND agent_configs.user_id = auth.uid()));

DROP POLICY IF EXISTS user_design_folders_policy ON design_folders;
CREATE POLICY user_design_folders_policy ON design_folders
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_agent_design_folders_policy ON agent_design_folders;
CREATE POLICY user_agent_design_folders_policy ON agent_design_folders
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM agent_configs WHERE agent_configs.id = agent_design_folders.agent_id AND agent_configs.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM agent_configs WHERE agent_configs.id = agent_design_folders.agent_id AND agent_configs.user_id = auth.uid()));

-- ── Realtime: Enable for instant config reloads ──────────────
ALTER PUBLICATION supabase_realtime ADD TABLE workflows;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_configs;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_tool_assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE mcp_connections;
ALTER PUBLICATION supabase_realtime ADD TABLE telegram_chat_bindings;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_scheduled_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE design_folders;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_design_folders;

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_configs_type
  ON agent_configs(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_tool_assignments_agent
  ON agent_tool_assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_status
  ON mcp_connections(status);
CREATE INDEX IF NOT EXISTS idx_agent_scheduled_tasks_next_run
  ON agent_scheduled_tasks(next_run_at) WHERE enabled = true;

-- ── thread_files: Unified file registry for portable storage (R2 + Supabase) ──
-- Tracks every file the system stores (user attachments + agent-generated files)
-- so any deployment (web VPS, PC build) can resolve files via Supabase + R2 links.

CREATE TABLE IF NOT EXISTS public.thread_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  thread_id       TEXT,
  filename        TEXT NOT NULL,
  storage_backend TEXT NOT NULL DEFAULT 'r2',       -- 'r2' | 'supabase'
  storage_key     TEXT NOT NULL,                    -- R2 object key / Supabase storage path
  public_url      TEXT,
  size_bytes      BIGINT,
  mime_type       TEXT,
  category        TEXT NOT NULL DEFAULT 'general',  -- uploads | terminal | tts | images | kie-targets | heredoc
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,                      -- NULL = keep forever
  UNIQUE(storage_backend, storage_key)
);

ALTER TABLE public.thread_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_thread_files_policy ON public.thread_files;
CREATE POLICY user_thread_files_policy ON public.thread_files
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_thread_files_expires_at
  ON public.thread_files(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thread_files_thread
  ON public.thread_files(thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_files_user
  ON public.thread_files(user_id);

-- ── manage_scheduled_tasks_admin RPC ─────────────────────────
-- Drop any older overload first (CREATE OR REPLACE with a new arg list creates an overload, not a replacement)
DROP FUNCTION IF EXISTS public.manage_scheduled_tasks_admin(
  TEXT, UUID, UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, BOOLEAN,
  JSONB, JSONB, TEXT, INTEGER, BOOLEAN, TEXT, TEXT, JSONB, TEXT, TIMESTAMPTZ, JSONB
);
CREATE OR REPLACE FUNCTION public.manage_scheduled_tasks_admin(
  p_action TEXT,
  p_user_id UUID,
  p_job_id UUID DEFAULT NULL,
  p_name TEXT DEFAULT NULL,
  p_prompt TEXT DEFAULT NULL,
  p_skills JSONB DEFAULT NULL,
  p_model TEXT DEFAULT NULL,
  p_provider TEXT DEFAULT NULL,
  p_base_url TEXT DEFAULT NULL,
  p_script TEXT DEFAULT NULL,
  p_no_agent BOOLEAN DEFAULT NULL,
  p_context_from JSONB DEFAULT NULL,
  p_schedule JSONB DEFAULT NULL,
  p_schedule_display TEXT DEFAULT NULL,
  p_repeat_times INTEGER DEFAULT NULL,
  p_enabled BOOLEAN DEFAULT NULL,
  p_state TEXT DEFAULT NULL,
  p_deliver TEXT DEFAULT NULL,
  p_enabled_toolsets JSONB DEFAULT NULL,
  p_workdir TEXT DEFAULT NULL,
  p_next_run_at TIMESTAMPTZ DEFAULT NULL,
  p_timezone TEXT DEFAULT NULL,
  p_mount_chat TEXT DEFAULT NULL,
  p_context_summary TEXT DEFAULT NULL,
  p_origin JSONB DEFAULT NULL,
  p_updates JSONB DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSON;
  v_row RECORD;
BEGIN
  IF p_action = 'create' THEN
    INSERT INTO public.agent_scheduled_tasks (
      user_id, name, prompt, skills, model, provider, base_url, script, no_agent,
      context_from, schedule, schedule_display, repeat_times, enabled, state,
      deliver, enabled_toolsets, workdir, next_run_at,
      timezone, mount_chat, context_summary, origin
    ) VALUES (
      p_user_id, p_name, p_prompt, COALESCE(p_skills, '[]'::jsonb), p_model, p_provider, p_base_url, p_script, COALESCE(p_no_agent, false),
      COALESCE(p_context_from, '[]'::jsonb), p_schedule, p_schedule_display, p_repeat_times, COALESCE(p_enabled, true), COALESCE(p_state, 'scheduled'),
      p_deliver, COALESCE(p_enabled_toolsets, '[]'::jsonb), p_workdir, p_next_run_at,
      p_timezone, p_mount_chat, p_context_summary, COALESCE(p_origin, '{}'::jsonb)
    )
    RETURNING * INTO v_row;
    
    RETURN json_build_object('success', true, 'data', row_to_json(v_row));
    
  ELSIF p_action = 'list' THEN
    SELECT json_agg(t) INTO v_result FROM (
      SELECT id, name, schedule_display, enabled, state, next_run_at, last_run_at, last_status, timezone
      FROM public.agent_scheduled_tasks
      WHERE user_id IS NOT DISTINCT FROM p_user_id
      ORDER BY created_at DESC
    ) t;
    
    RETURN json_build_object('success', true, 'data', COALESCE(v_result, '[]'::json));
    
  ELSIF p_action = 'get' THEN
    SELECT row_to_json(t) INTO v_result FROM (
      SELECT * FROM public.agent_scheduled_tasks
      WHERE id = p_job_id AND user_id IS NOT DISTINCT FROM p_user_id
    ) t;
    
    IF v_result IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Task not found');
    END IF;
    RETURN json_build_object('success', true, 'data', v_result);
    
  ELSIF p_action = 'delete' THEN
    DELETE FROM public.agent_scheduled_tasks
    WHERE id = p_job_id AND user_id IS NOT DISTINCT FROM p_user_id
    RETURNING * INTO v_row;
    
    IF v_row IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Task not found');
    END IF;
    RETURN json_build_object('success', true, 'data', row_to_json(v_row));
    
  ELSIF p_action = 'update' THEN
    IF p_updates IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Updates payload is null');
    END IF;

    UPDATE public.agent_scheduled_tasks
    SET
      name = CASE WHEN p_updates ? 'name' THEN (p_updates->>'name') ELSE name END,
      prompt = CASE WHEN p_updates ? 'prompt' THEN (p_updates->>'prompt') ELSE prompt END,
      skills = CASE WHEN p_updates ? 'skills' THEN (p_updates->'skills') ELSE skills END,
      model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
      provider = CASE WHEN p_updates ? 'provider' THEN (p_updates->>'provider') ELSE provider END,
      base_url = CASE WHEN p_updates ? 'base_url' THEN (p_updates->>'base_url') ELSE base_url END,
      script = CASE WHEN p_updates ? 'script' THEN (p_updates->>'script') ELSE script END,
      no_agent = CASE WHEN p_updates ? 'no_agent' THEN (p_updates->>'no_agent')::boolean ELSE no_agent END,
      context_from = CASE WHEN p_updates ? 'context_from' THEN (p_updates->'context_from') ELSE context_from END,
      schedule = CASE WHEN p_updates ? 'schedule' THEN (p_updates->'schedule') ELSE schedule END,
      schedule_display = CASE WHEN p_updates ? 'schedule_display' THEN (p_updates->>'schedule_display') ELSE schedule_display END,
      repeat_times = CASE WHEN p_updates ? 'repeat_times' THEN (p_updates->>'repeat_times')::integer ELSE repeat_times END,
      enabled = CASE WHEN p_updates ? 'enabled' THEN (p_updates->>'enabled')::boolean ELSE enabled END,
      state = CASE WHEN p_updates ? 'state' THEN (p_updates->>'state') ELSE state END,
      deliver = CASE WHEN p_updates ? 'deliver' THEN (p_updates->>'deliver') ELSE deliver END,
      enabled_toolsets = CASE WHEN p_updates ? 'enabled_toolsets' THEN (p_updates->'enabled_toolsets') ELSE enabled_toolsets END,
      workdir = CASE WHEN p_updates ? 'workdir' THEN (p_updates->>'workdir') ELSE workdir END,
      timezone = CASE WHEN p_updates ? 'timezone' THEN (p_updates->>'timezone') ELSE timezone END,
      mount_chat = CASE WHEN p_updates ? 'mount_chat' THEN (p_updates->>'mount_chat') ELSE mount_chat END,
      context_summary = CASE WHEN p_updates ? 'context_summary' THEN (p_updates->>'context_summary') ELSE context_summary END,
      origin = CASE WHEN p_updates ? 'origin' THEN (p_updates->'origin') ELSE origin END,
      next_run_at = CASE WHEN p_updates ? 'next_run_at' THEN (p_updates->>'next_run_at')::timestamptz ELSE next_run_at END,
      paused_at = CASE WHEN p_updates ? 'paused_at' THEN (p_updates->>'paused_at')::timestamptz ELSE paused_at END,
      updated_at = now()
    WHERE id = p_job_id AND user_id IS NOT DISTINCT FROM p_user_id
    RETURNING * INTO v_row;
    
    IF v_row IS NULL THEN
      RETURN json_build_object('success', false, 'error', 'Task not found');
    END IF;
    RETURN json_build_object('success', true, 'data', row_to_json(v_row));
    
  ELSE
    RETURN json_build_object('success', false, 'error', 'Invalid action');
  END IF;
END;
$$;

-- ── plugins / user_plugin_settings ──────────────────────────
CREATE TABLE IF NOT EXISTS public.plugins (
  plugin_key      TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  description     TEXT,
  icon            TEXT,
  page_route      TEXT,
  settings_route  TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  default_enabled BOOLEAN NOT NULL DEFAULT true,
  tool_keys       TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_plugin_settings (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plugin_key TEXT NOT NULL REFERENCES public.plugins(plugin_key) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, plugin_key)
);

ALTER TABLE public.plugins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_plugin_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plugins_select_all ON public.plugins;
CREATE POLICY plugins_select_all ON public.plugins FOR SELECT USING (true);

DROP POLICY IF EXISTS user_plugin_settings_user_policy ON public.user_plugin_settings;
CREATE POLICY user_plugin_settings_user_policy ON public.user_plugin_settings
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

INSERT INTO public.plugins (plugin_key, label, description, icon, page_route, settings_route, sort_order, default_enabled, tool_keys)
VALUES
  ('posts', 'Posts', 'Post editor, publisher and WordPress / social media integration', 'FileText', '/posts', '/posts/settings', 1, true, ARRAY['save_posts_to_supabase','get_wordpress_categories','publish_to_wordpress']),
  ('feeder', 'Feeder', 'RSS ingestion and article deduplication pipeline', 'Rss', '/feeder', '/feeder/settings', 2, true, ARRAY[]::text[])
ON CONFLICT (plugin_key) DO NOTHING;

SELECT 'Migration complete ✅' AS status;
