-- =============================================================================
-- Migration: smithery_server_installs
-- Purpose: Tracks Smithery MCP servers that have been installed server-side
--          via `npx @smithery/cli install`. This is a SHARED table — one entry
--          per package, across all users. Each user then creates their own
--          entry in `mcp_connections` with their personal credentials.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.smithery_server_installs (
  id                UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
  qualified_name    TEXT    NOT NULL UNIQUE,
  display_name      TEXT    NOT NULL,

  -- Status: 'installing' | 'installed' | 'failed'
  status            TEXT    NOT NULL DEFAULT 'installing',

  -- The npx install config extracted from Claude Desktop config
  -- { "command": "npx", "args": [...], "env": {} }
  install_config    JSONB,

  error_message     TEXT,
  installed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Index for quick lookup by qualified_name
CREATE INDEX IF NOT EXISTS smithery_server_installs_qualified_name_idx
  ON public.smithery_server_installs (qualified_name);

-- Index for status queries
CREATE INDEX IF NOT EXISTS smithery_server_installs_status_idx
  ON public.smithery_server_installs (status);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_smithery_installs_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS smithery_installs_updated_at ON public.smithery_server_installs;
CREATE TRIGGER smithery_installs_updated_at
  BEFORE UPDATE ON public.smithery_server_installs
  FOR EACH ROW EXECUTE FUNCTION update_smithery_installs_timestamp();

-- RLS (Row Level Security) — allow all authenticated users to read
-- Only service_role (backend API) can write
ALTER TABLE public.smithery_server_installs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can read Smithery installs"
  ON public.smithery_server_installs
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage Smithery installs"
  ON public.smithery_server_installs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow anon key to insert/update (for the Next.js API routes which use anon key)
CREATE POLICY "Anon key can manage Smithery installs"
  ON public.smithery_server_installs
  FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- Comment describing multi-tenant usage pattern:
-- =============================================================================
COMMENT ON TABLE public.smithery_server_installs IS
  'Server-wide registry of Smithery MCP packages installed via npx CLI. '
  'One record per package, shared across all users. '
  'Individual user connections (with their own API credentials) are stored '
  'separately in mcp_connections with connection_type=''manual'' and '
  'smithery_mode=''local'' or ''remote'' inside the mcp_url JSON.';
