#!/usr/bin/env python3
"""
setup_db.py — One-command Supabase database setup for Deep Agents.

Usage:
    python setup_db.py

This script:
1. Creates all required tables (safe — skips if already exist)
2. Seeds default agent configs from existing prompts
3. Seeds default tool assignments
4. Seeds default skills (blog_post_writer)

Run once after installation or after pulling updates.
Requires SUPABASE_URL and SUPABASE_ANON_KEY in .env
"""

import os
import json
import sys
import io
from pathlib import Path
from dotenv import load_dotenv

# Reconfigure stdout/stderr to use UTF-8 on Windows consoles to prevent UnicodeEncodeError
if sys.platform.startswith("win"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌  SUPABASE_URL and either SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY must be set in .env")
    sys.exit(1)

try:
    from supabase import create_client, Client
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
except ImportError:
    print("❌  supabase package not installed. Run: pip install supabase")
    sys.exit(1)

# ── Load existing prompts from prompts.py for seeding ────────────────────────
try:
    from research_agent.prompts import (
        MAIN_AGENT_INSTRUCTIONS,
        RESEARCH_SUBAGENT_PROMPT,
        CONTENT_SUBAGENT_PROMPT,
    )
    PROMPTS_AVAILABLE = True
except ImportError:
    PROMPTS_AVAILABLE = False
    MAIN_AGENT_INSTRUCTIONS = ""
    RESEARCH_SUBAGENT_PROMPT = ""
    CONTENT_SUBAGENT_PROMPT = ""

# ── Load existing skill ───────────────────────────────────────────────────────
_SKILLS_ROOT = Path(__file__).parent / "research_agent" / "skills"
_BLOG_SKILL_PATH = _SKILLS_ROOT / "blog_post_writer" / "SKILL.md"


def _read_file(path: Path) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


def _run_sql_via_rpc(sql: str, description: str) -> bool:
    """Execute raw SQL via Supabase. Returns True on success."""
    try:
        supabase.rpc("exec_sql", {"sql": sql}).execute()
        print(f"  ✅ {description}")
        return True
    except Exception as e:
        # If exec_sql RPC doesn't exist, we'll use REST API directly
        return False


def _upsert_rows(table: str, rows: list[dict], conflict_col: str) -> bool:
    """Upsert rows into a Supabase table."""
    try:
        supabase.table(table).upsert(rows, on_conflict=conflict_col).execute()
        return True
    except Exception as e:
        print(f"  ⚠️  Upsert to {table} failed: {e}")
        return False


def _table_exists(table: str) -> bool:
    """Check if a table already exists by doing a minimal select."""
    try:
        supabase.table(table).select("id").limit(1).execute()
        return True
    except Exception:
        return False


def run_sql_migration_direct(sql: str) -> bool:
    """Connect to Supabase PostgreSQL database directly using pg8000 and run migrations."""
    db_password = os.environ.get("SUPABASE_DB_PASSWORD", "")
    if not db_password:
        return False

    # Extract project ID from SUPABASE_URL
    import re
    match = re.search(r"https://([^.]+)\.supabase\.co", SUPABASE_URL)
    if not match:
        print(f"  ❌ Could not parse project ID from SUPABASE_URL: {SUPABASE_URL}")
        return False
    
    project_id = match.group(1)
    host = f"db.{project_id}.supabase.co"
    port_str = os.environ.get("SUPABASE_DB_PORT", "5432")
    try:
        port = int(port_str)
    except ValueError:
        port = 5432
    
    print(f"  🔌 Connecting directly to Supabase DB: {host}:{port}...")
    try:
        import pg8000
        conn = pg8000.connect(
            user="postgres",
            host=host,
            database="postgres",
            port=port,
            password=db_password
        )
        cursor = conn.cursor()
        
        print("  🚀 Running migration SQL...")
        cursor.execute(sql)
        conn.commit()
        cursor.close()
        conn.close()
        print("  ✅ Database schema successfully created/updated!")
        return True
    except ImportError:
        print("  ❌ pg8000 package not installed. Run: pip install pg8000")
        return False
    except Exception as e:
        print(f"  ❌ Failed to execute SQL directly: {e}")
        return False


def create_tables():
    """Print the SQL for creating all tables and guide user through Supabase dashboard."""
    print("\n" + "=" * 60)
    print("  STEP 1: Create Tables in Supabase")
    print("=" * 60)

    # Check which tables already exist
    tables_to_create = []
    for table in ["workflows", "agent_configs", "agent_tool_assignments",
                  "mcp_connections", "skills_library", "design_assets", "design_folders", "agent_design_folders",
                  "telegram_chat_bindings", "telegram_bots",
                  "agent_scheduled_tasks", "plugins", "user_plugin_settings"]:
        exists = _table_exists(table)
        status = "✅ exists" if exists else "❌ missing"
        print(f"  {table}: {status}")
        if not exists:
            tables_to_create.append(table)

    if not tables_to_create:
        print("\n  ✅ All tables already exist — skipping creation.")
        return True

    sql = generate_migration_sql()

    # Save to a file for convenience/reference
    sql_file = Path("supabase_migration.sql")
    try:
        sql_file.write_text(sql, encoding="utf-8")
        print(f"  💾 SQL script saved to: {sql_file.resolve()}")
    except Exception:
        pass

    # Attempt direct postgres execution if DB password is provided
    if os.environ.get("SUPABASE_DB_PASSWORD"):
        print(f"\n  ⚠️  {len(tables_to_create)} table(s) need to be created. Attempting automatic migration...")
        success = run_sql_migration_direct(sql)
        if success:
            return True
        print("  ⚠️  Automatic migration failed. Falling back to manual setup instructions.")

    print(f"\n  ⚠️  {len(tables_to_create)} table(s) need to be created.")
    print("\n  Run this SQL in your Supabase SQL Editor:")
    print("  https://supabase.com/dashboard → SQL Editor → New Query\n")
    print("-" * 60)
    print(sql)
    print("-" * 60)
    print("\n  After running the SQL, run this script again to seed data.")
    return False


def generate_migration_sql() -> str:
    """Generate the complete SQL migration for all tables."""
    return """
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
"""


def seed_workflows():
    """Seed default workflow and link existing configs to it."""
    print("\n" + "=" * 60)
    print("  STEP 1.5: Seed Default Workflow")
    print("=" * 60)
    try:
        existing = supabase.table("workflows").select("id").eq("name", "Default Workflow").execute()
        if existing.data:
            print("  ⏭️  Default Workflow: already exists — skipping")
            wf_id = existing.data[0]["id"]
        else:
            resp = supabase.table("workflows").insert({
                "name": "Default Workflow",
                "description": "Legacy single-workflow configuration",
                "enabled": True,
                "interval_minutes": 30,
                "batch_size": 2
            }).execute()
            print("  ✅ Default Workflow: created")
            wf_id = resp.data[0]["id"]

        # Link existing unlinked agent configs to this workflow
        supabase.table("agent_configs").update({"workflow_id": wf_id}).is_("workflow_id", "null").execute()
        print("  ✅ Linked unassigned agents to Default Workflow")
        
        # Link existing unlinked feeder sources to this workflow
        supabase.table("feeder_sources").update({"workflow_id": wf_id}).is_("workflow_id", "null").execute()
        print("  ✅ Linked unassigned feeder sources to Default Workflow")

        # Link existing unlinked articles to this workflow
        supabase.table("feeder_articles").update({"workflow_id": wf_id}).is_("workflow_id", "null").execute()
        print("  ✅ Linked unassigned articles to Default Workflow")
        return wf_id
    except Exception as e:
        print(f"  ❌ Seed workflows failed: {e}")
        return None


def seed_agent_configs():
    """Seed default agent configs from existing prompts."""
    print("\n" + "=" * 60)
    print("  STEP 2: Seed Default Agent Configs")
    print("=" * 60)

    if not PROMPTS_AVAILABLE:
        print("  ⚠️  Could not import research_agent.prompts — skipping prompt seed.")
        return

    # Date placeholder for main agent prompt
    main_prompt = MAIN_AGENT_INSTRUCTIONS.replace("{date}", "{date}")

    agents = [
        {
            "name": "Main Agent",
            "agent_type": "main",
            "description": "Manager: planning, synthesis, WordPress, database save",
            "system_prompt": main_prompt,
            "model_key": "main_agent",
            "enabled": True,
            "sort_order": 0,
            "is_builtin": True,
        },
        {
            "name": "Research Subagent",
            "agent_type": "subagent",
            "description": "Web research specialist — search + extract for research targets",
            "system_prompt": RESEARCH_SUBAGENT_PROMPT,
            "model_key": "research_subagent",
            "enabled": True,
            "sort_order": 1,
            "is_builtin": True,
        },
        {
            "name": "Content Subagent",
            "agent_type": "subagent",
            "description": "Content creation specialist — blog post, social posts, image pipeline",
            "system_prompt": CONTENT_SUBAGENT_PROMPT,
            "model_key": "content_subagent",
            "enabled": True,
            "sort_order": 2,
            "is_builtin": True,
        },
        {
            "name": "Image Analyzer Subagent",
            "agent_type": "subagent",
            "description": "Selects best news image and generates THE ECHO brand editing prompt",
            "system_prompt": """# Image Analyzer Specialist

You are a visual editor for the brand. Your job:
1. Receive candidate image URLs from the main pipeline
2. Call `analyze_images_gemini` with 3-5 candidate URLs
3. Call `get_design_guide` if you need brand reference
4. Return the chosen_image_url and editing_prompt JSON

Return ONLY a JSON summary of results for the calling agent.
""",
            "model_key": "analyzer",
            "enabled": True,
            "sort_order": 3,
            "is_builtin": False,
        },
    ]

    for agent in agents:
        try:
            # Check if already exists by name
            existing = supabase.table("agent_configs").select("id").eq("name", agent["name"]).execute()
            if existing.data:
                print(f"  ⏭️  {agent['name']}: already exists — skipping")
            else:
                supabase.table("agent_configs").insert(agent).execute()
                print(f"  ✅ {agent['name']}: created")
        except Exception as e:
            print(f"  ❌ {agent['name']}: failed — {e}")


def seed_tool_assignments():
    """Seed default tool assignments for each agent."""
    print("\n" + "=" * 60)
    print("  STEP 3: Seed Default Tool Assignments")
    print("=" * 60)

    # Get agent IDs
    try:
        agents_resp = supabase.table("agent_configs").select("id,name").execute()
        agents_by_name = {a["name"]: a["id"] for a in (agents_resp.data or [])}
    except Exception as e:
        print(f"  ❌ Could not fetch agent configs: {e}")
        return

    TOOL_ASSIGNMENTS = {
        "Main Agent": [
            ("builtin", "unified_search",        "Web Search"),
            ("builtin", "unified_extract",        "URL Extractor"),
            ("builtin", "think_tool",             "Think Tool"),
            ("builtin", "fetch_images_brave",     "Brave Image Search"),
            ("builtin", "analyze_images_gemini",  "Image Analyzer"),
            ("builtin", "create_post_image",      "Image Generator"),
            ("builtin", "save_posts_to_supabase", "Save to Database"),
            ("builtin", "get_design_guide",       "Design Guide"),
            ("builtin", "read_skill",             "Read Skill"),
            ("builtin", "list_skills",             "List Skills"),
            ("builtin", "manage_skill",            "Manage Skill"),
            ("builtin", "get_wordpress_categories", "WP Categories"),
            ("builtin", "publish_to_wordpress",   "Publish to WordPress"),
            ("builtin", "youtube_transcript",     "YouTube Transcript"),
            ("builtin", "cronjob",                "Cron Scheduler"),
            ("builtin", "text_to_speech",         "Text to Speech"),
            ("builtin", "terminal",               "Terminal (approval-gated)"),
            ("builtin", "upload_to_storage",      "Upload to Storage"),
        ],
        "Research Subagent": [
            ("builtin", "unified_search",   "Web Search"),
            ("builtin", "unified_extract",  "URL Extractor"),
            ("builtin", "think_tool",       "Think Tool"),
            ("builtin", "youtube_transcript", "YouTube Transcript"),
        ],
        "Content Subagent": [
            ("builtin", "read_skill",            "Read Skill"),
            ("builtin", "fetch_images_brave",    "Brave Image Search"),
            ("builtin", "analyze_images_gemini", "Image Analyzer"),
            ("builtin", "create_post_image",     "Image Generator"),
            ("builtin", "get_design_guide",      "Design Guide"),
            ("builtin", "think_tool",            "Think Tool"),
        ],
        "Image Analyzer Subagent": [
            ("builtin", "analyze_images_gemini", "Image Analyzer"),
            ("builtin", "get_design_guide",      "Design Guide"),
        ],
    }

    for agent_name, tools in TOOL_ASSIGNMENTS.items():
        agent_id = agents_by_name.get(agent_name)
        if not agent_id:
            print(f"  ⚠️  {agent_name}: not found in DB — skipping tool assignment")
            continue
        for tool_type, tool_key, tool_label in tools:
            try:
                supabase.table("agent_tool_assignments").upsert(
                    {
                        "agent_id":   agent_id,
                        "tool_type":  tool_type,
                        "tool_key":   tool_key,
                        "tool_label": tool_label,
                        "enabled":    True,
                    },
                    on_conflict="agent_id,tool_key"
                ).execute()
            except Exception as e:
                print(f"  ⚠️  {agent_name}/{tool_key}: {e}")
        print(f"  ✅ {agent_name}: {len(tools)} tools assigned")


def seed_skills():
    """Seed blog_post_writer skill from filesystem."""
    print("\n" + "=" * 60)
    print("  STEP 4: Seed Skills Library")
    print("=" * 60)

    skill_content = _read_file(_BLOG_SKILL_PATH)
    if not skill_content:
        print("  ⚠️  blog_post_writer/SKILL.md not found — skipping")
        return

    try:
        existing = supabase.table("skills_library").select("id").eq("skill_key", "blog_post_writer").execute()
        if existing.data:
            print("  ⏭️  blog_post_writer: already exists — skipping")
        else:
            supabase.table("skills_library").insert({
                "skill_key":   "blog_post_writer",
                "label":       "Blog Post Writer",
                "description": "Step-by-step instructions for writing SEO blog posts for THE ECHO brand",
                "content":     skill_content,
                "source":      "builtin",
                "category":    "content",
                "state":       "active",
                "created_by":  "system",
            }).execute()
            print("  ✅ blog_post_writer: seeded")
    except Exception as e:
        print(f"  ❌ blog_post_writer: {e}")

    # Seed additional skills
    extra_skills = [
        {
            "skill_key": "web_research",
            "label": "Web Research",
            "description": "Systematic web research — search strategies, source evaluation, fact verification.",
            "category": "research",
        },
        {
            "skill_key": "seo_optimizer",
            "label": "SEO Optimizer",
            "description": "On-page SEO optimization — keyword placement, meta tags, heading structure.",
            "category": "content",
        },
        {
            "skill_key": "social_media_writer",
            "label": "Social Media Writer",
            "description": "Platform-specific social post creation — hooks, limits, hashtag strategy.",
            "category": "content",
        },
        {
            "skill_key": "wordpress_publishing",
            "label": "WordPress Publishing",
            "description": "End-to-end WordPress publishing — categories, images, post formatting.",
            "category": "publishing",
        },
    ]
    for sk in extra_skills:
        try:
            existing = supabase.table("skills_library").select("id").eq("skill_key", sk["skill_key"]).execute()
            if existing.data:
                print(f"  ⏭️  {sk['skill_key']}: already exists — skipping")
            else:
                supabase.table("skills_library").insert({
                    **sk,
                    "content": f"Skill content for {sk['label']} — run skills_migration.sql to populate full content.",
                    "source": "system",
                    "state": "active",
                    "created_by": "system",
                }).execute()
                print(f"  ✅ {sk['skill_key']}: seeded")
        except Exception as e:
            print(f"  ❌ {sk['skill_key']}: {e}")


def seed_plugins():
    """Seed the plugin catalog (posts, feeder)."""
    print("\n" + "=" * 60)
    print("  STEP 6: Seed Plugin Catalog")
    print("=" * 60)

    plugins = [
        {
            "plugin_key": "posts",
            "label": "Posts",
            "description": "Post editor, publisher and WordPress / social media integration",
            "icon": "FileText",
            "page_route": "/posts",
            "settings_route": "/posts/settings",
            "sort_order": 1,
            "default_enabled": True,
            "tool_keys": ["save_posts_to_supabase", "get_wordpress_categories", "publish_to_wordpress"],
        },
        {
            "plugin_key": "feeder",
            "label": "Feeder",
            "description": "RSS ingestion and article deduplication pipeline",
            "icon": "Rss",
            "page_route": "/feeder",
            "settings_route": "/feeder/settings",
            "sort_order": 2,
            "default_enabled": True,
            "tool_keys": [],
        },
    ]

    for plugin in plugins:
        try:
            existing = supabase.table("plugins").select("plugin_key").eq("plugin_key", plugin["plugin_key"]).execute()
            if existing.data:
                print(f"  ⏭️  {plugin['plugin_key']}: already exists — skipping")
            else:
                supabase.table("plugins").insert(plugin).execute()
                print(f"  ✅ {plugin['plugin_key']}: seeded")
        except Exception as e:
            print(f"  ❌ {plugin['plugin_key']}: {e}")


def seed_design_assets():
    """Seed design asset metadata (ref images)."""
    print("\n" + "=" * 60)
    print("  STEP 5: Seed Design Assets")
    print("=" * 60)

    assets = [
        {
            "asset_key":   "ref_image_1",
            "label":       "Brand Reference Image 1",
            "file_path":   "reference images/ref1.png",
            "description": "Primary brand style reference for THE ECHO image overlay",
        },
        {
            "asset_key":   "ref_image_2",
            "label":       "Brand Reference Image 2",
            "file_path":   "reference images/ref2.png",
            "description": "Secondary brand style reference for THE ECHO image overlay",
        },
    ]

    for asset in assets:
        try:
            existing = supabase.table("design_assets").select("id").eq("asset_key", asset["asset_key"]).execute()
            if existing.data:
                print(f"  ⏭️  {asset['label']}: already exists — skipping")
            else:
                supabase.table("design_assets").insert(asset).execute()
                print(f"  ✅ {asset['label']}: registered")
        except Exception as e:
            print(f"  ❌ {asset['label']}: {e}")


def print_env_reminder():
    """Remind user to add new env vars."""
    print("\n" + "=" * 60)
    print("  Add These to Your .env (if not already set)")
    print("=" * 60)
    print("""
  # Composio MCP Gateway (get free key at https://app.composio.dev)
  COMPOSIO_API_KEY=your_composio_api_key_here

  # Supabase Auth — set a JWT secret for session security
  # (already set automatically in Supabase — no action needed)
""")


def main():
    print("\n" + "=" * 60)
    print("  Deep Agents - Database Setup")
    print("  Connected to:", SUPABASE_URL[:40] + "...")
    print("=" * 60)

    # Check/create tables
    all_exist = not create_tables()

    if all_exist:
        seed_workflows()
        seed_agent_configs()
        seed_tool_assignments()
        seed_skills()
        seed_plugins()
        seed_design_assets()
        print_env_reminder()
        print("\n" + "=" * 60)
        print("  Setup complete! Start the app:")
        print("     langgraph dev        (Python backend)")
        print("     npm run dev          (Next.js frontend, in deep-agents-ui-main/)")
        print("=" * 60 + "\n")
    else:
        print("\n  ⚠️  Run the SQL above in Supabase, then run this script again.")


if __name__ == "__main__":
    main()
