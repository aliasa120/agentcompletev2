
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
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

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
  last_run_at         TIMESTAMPTZ,
  last_run_logs       TEXT,
  last_status         TEXT,
  last_error          TEXT,
  next_run_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- ── RLS: Enable RLS on all tables for workspace isolation ──
ALTER TABLE workflows              ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections        ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills_library         ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_assets          ENABLE ROW LEVEL SECURITY;
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

-- ── Realtime: Enable for instant config reloads ──────────────
ALTER PUBLICATION supabase_realtime ADD TABLE workflows;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_configs;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_tool_assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE mcp_connections;
ALTER PUBLICATION supabase_realtime ADD TABLE telegram_chat_bindings;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_scheduled_tasks;

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_configs_type
  ON agent_configs(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_tool_assignments_agent
  ON agent_tool_assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_status
  ON mcp_connections(status);
CREATE INDEX IF NOT EXISTS idx_agent_scheduled_tasks_next_run
  ON agent_scheduled_tasks(next_run_at) WHERE enabled = true;

SELECT 'Migration complete ✅' AS status;
