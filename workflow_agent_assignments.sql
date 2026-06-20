-- Create junction table for many-to-many workflow-agent mapping
CREATE TABLE IF NOT EXISTS workflow_agent_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  agent_id    UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workflow_id, agent_id)
);

-- Disable Row Level Security (aligns with project architecture)
ALTER TABLE workflow_agent_assignments DISABLE ROW LEVEL SECURITY;

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE workflow_agent_assignments;

-- Migrate existing single-column mappings
INSERT INTO workflow_agent_assignments (workflow_id, agent_id)
SELECT workflow_id, id 
FROM agent_configs 
WHERE workflow_id IS NOT NULL
ON CONFLICT (workflow_id, agent_id) DO NOTHING;
