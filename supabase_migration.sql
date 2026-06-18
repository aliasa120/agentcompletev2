
-- ============================================================
-- Deep Agents — Full Database Migration
-- Run this in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension (usually already enabled)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── workflows ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  description     TEXT DEFAULT '',
  enabled         BOOLEAN DEFAULT true,
  interval_minutes INTEGER DEFAULT 30,
  batch_size      INTEGER DEFAULT 2,
  last_trigger_at TIMESTAMPTZ,
  feeder_enabled  BOOLEAN DEFAULT true,
  feeder_interval_minutes INTEGER DEFAULT 30,
  feeder_last_trigger_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ── agent_configs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  connection_type   TEXT NOT NULL DEFAULT 'manual',
  toolkit_slug      TEXT DEFAULT '',
  label             TEXT NOT NULL,
  mcp_url           TEXT DEFAULT '',
  composio_conn_id  TEXT UNIQUE,
  status            TEXT DEFAULT 'active',
  available_tools   JSONB DEFAULT '[]',
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- ── skills_library ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills_library (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_key   TEXT UNIQUE NOT NULL,
  label       TEXT NOT NULL,
  description TEXT DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  source      TEXT DEFAULT 'user',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ── design_assets ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS design_assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_key   TEXT UNIQUE NOT NULL,
  label       TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
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

-- ── Add workflow_id references to feeder/social tables if they exist ──
ALTER TABLE feeder_sources ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL;
ALTER TABLE feeder_articles ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL;

-- ── RLS: Disable RLS on all tables (team app — auth guards routes) ──
ALTER TABLE workflows              DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs          DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tool_assignments DISABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections        DISABLE ROW LEVEL SECURITY;
ALTER TABLE skills_library         DISABLE ROW LEVEL SECURITY;
ALTER TABLE design_assets          DISABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_chat_bindings  DISABLE ROW LEVEL SECURITY;

-- ── Realtime: Enable for instant config reloads ──────────────
ALTER PUBLICATION supabase_realtime ADD TABLE workflows;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_configs;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_tool_assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE mcp_connections;
ALTER PUBLICATION supabase_realtime ADD TABLE telegram_chat_bindings;

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agent_configs_type
  ON agent_configs(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_tool_assignments_agent
  ON agent_tool_assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_status
  ON mcp_connections(status);

SELECT 'Migration complete ✅' AS status;
