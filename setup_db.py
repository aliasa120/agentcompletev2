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
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    print("❌  SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env")
    sys.exit(1)

try:
    from supabase import create_client, Client
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
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
                  "mcp_connections", "skills_library", "design_assets", "telegram_chat_bindings", "telegram_bots"]:
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
  is_active       BOOLEAN DEFAULT true,
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

-- ── telegram_bots ───────────────────────────────────────────
-- Each bot routes to ALL enabled workflows via /start inline keyboard.
-- workflow_id was removed: bots are no longer bound to a single workflow.
CREATE TABLE IF NOT EXISTS telegram_bots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_token   TEXT NOT NULL UNIQUE,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
-- Migration: drop legacy workflow_id column if it exists
ALTER TABLE telegram_bots DROP COLUMN IF EXISTS workflow_id;

-- Migration: add is_active column to workflows table if it doesn't exist
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

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
ALTER TABLE telegram_bots           DISABLE ROW LEVEL SECURITY;

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
            ("builtin", "view_candidate_images",  "View Candidate Images"),
            ("builtin", "analyze_images_gemini",  "Image Analyzer"),
            ("builtin", "create_post_image",      "Image Generator"),
            ("builtin", "save_posts_to_supabase", "Save to Database"),
            ("builtin", "get_design_guide",       "Design Guide"),
            ("builtin", "read_skill",             "Read Skill"),
            ("builtin", "list_skills",             "List Skills"),
            ("builtin", "manage_skill",            "Manage Skill"),
            ("builtin", "get_wordpress_categories", "WP Categories"),
            ("builtin", "publish_to_wordpress",   "Publish to WordPress"),
        ],
        "Research Subagent": [
            ("builtin", "unified_search",   "Web Search"),
            ("builtin", "unified_extract",  "URL Extractor"),
            ("builtin", "think_tool",       "Think Tool"),
        ],
        "Content Subagent": [
            ("builtin", "read_skill",            "Read Skill"),
            ("builtin", "fetch_images_brave",    "Brave Image Search"),
            ("builtin", "view_candidate_images", "View Candidate Images"),
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
