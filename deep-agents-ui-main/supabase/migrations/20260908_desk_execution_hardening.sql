ALTER TABLE public.agent_tool_assignments
  ADD COLUMN IF NOT EXISTS loading_mode TEXT,
  ADD COLUMN IF NOT EXISTS permission_mode TEXT,
  ADD COLUMN IF NOT EXISTS parameter_bindings JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.desk_tasks
  ADD COLUMN IF NOT EXISTS execution_id UUID,
  ADD COLUMN IF NOT EXISTS execution_payload JSONB,
  ADD COLUMN IF NOT EXISTS run_id TEXT;

UPDATE public.desk_tasks
SET status = 'failed',
    error = COALESCE(error, 'Execution state was created before atomic Desk claims were enabled.')
WHERE status = 'executing'
  AND (execution_id IS NULL OR execution_payload IS NULL);

ALTER TABLE public.desk_tasks
  DROP CONSTRAINT IF EXISTS desk_tasks_status_check,
  ADD CONSTRAINT desk_tasks_status_check
    CHECK (status IN ('pending', 'executing', 'done', 'failed')) NOT VALID,
  DROP CONSTRAINT IF EXISTS desk_tasks_fields_array_check,
  ADD CONSTRAINT desk_tasks_fields_array_check
    CHECK (jsonb_typeof(fields) = 'array') NOT VALID,
  DROP CONSTRAINT IF EXISTS desk_tasks_buttons_array_check,
  ADD CONSTRAINT desk_tasks_buttons_array_check
    CHECK (jsonb_typeof(buttons) = 'array') NOT VALID,
  DROP CONSTRAINT IF EXISTS desk_tasks_files_array_check,
  ADD CONSTRAINT desk_tasks_files_array_check
    CHECK (jsonb_typeof(files) = 'array') NOT VALID,
  DROP CONSTRAINT IF EXISTS desk_tasks_execution_payload_check,
  ADD CONSTRAINT desk_tasks_execution_payload_check
    CHECK (execution_payload IS NULL OR jsonb_typeof(execution_payload) = 'object') NOT VALID,
  DROP CONSTRAINT IF EXISTS desk_tasks_executing_claim_check,
  ADD CONSTRAINT desk_tasks_executing_claim_check
    CHECK (status <> 'executing' OR (execution_id IS NOT NULL AND execution_payload IS NOT NULL)) NOT VALID;

ALTER TABLE public.desk_tasks VALIDATE CONSTRAINT desk_tasks_status_check;
ALTER TABLE public.desk_tasks VALIDATE CONSTRAINT desk_tasks_fields_array_check;
ALTER TABLE public.desk_tasks VALIDATE CONSTRAINT desk_tasks_buttons_array_check;
ALTER TABLE public.desk_tasks VALIDATE CONSTRAINT desk_tasks_files_array_check;
ALTER TABLE public.desk_tasks VALIDATE CONSTRAINT desk_tasks_execution_payload_check;
ALTER TABLE public.desk_tasks VALIDATE CONSTRAINT desk_tasks_executing_claim_check;

CREATE OR REPLACE FUNCTION public.replace_agent_tool_assignments(
  p_agent_id UUID,
  p_assignments JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.agent_configs
    WHERE id = p_agent_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'agent not found';
  END IF;

  IF jsonb_typeof(p_assignments) <> 'array' THEN
    RAISE EXCEPTION 'assignments must be an array';
  END IF;

  DELETE FROM public.agent_tool_assignments WHERE agent_id = p_agent_id;

  INSERT INTO public.agent_tool_assignments (
    agent_id, tool_type, tool_key, tool_label, enabled,
    loading_mode, permission_mode, parameter_bindings
  )
  SELECT
    p_agent_id,
    item->>'tool_type',
    item->>'tool_key',
    COALESCE(item->>'tool_label', item->>'tool_key'),
    COALESCE((item->>'enabled')::BOOLEAN, TRUE),
    NULLIF(item->>'loading_mode', ''),
    NULLIF(item->>'permission_mode', ''),
    COALESCE(item->'parameter_bindings', '{}'::jsonb)
  FROM jsonb_array_elements(p_assignments) AS item;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_desk_task_execution(
  p_task_id UUID,
  p_execution_id UUID,
  p_execution_payload JSONB
)
RETURNS SETOF public.desk_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR jsonb_typeof(p_execution_payload) <> 'object' THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.desk_tasks
  SET status = 'executing',
      execution_id = p_execution_id,
      execution_payload = p_execution_payload,
      run_id = NULL,
      result = NULL,
      error = NULL
  WHERE id = p_task_id
    AND user_id = auth.uid()
    AND status IN ('pending', 'failed')
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_desk_task_execution(
  p_task_id UUID,
  p_user_id UUID,
  p_execution_id UUID,
  p_expected_status TEXT,
  p_status TEXT,
  p_result TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL,
  p_executed_at TIMESTAMPTZ DEFAULT NULL,
  p_run_id TEXT DEFAULT NULL
)
RETURNS SETOF public.desk_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status NOT IN ('pending', 'done', 'failed') THEN
    RAISE EXCEPTION 'invalid target status';
  END IF;

  RETURN QUERY
  UPDATE public.desk_tasks
  SET status = p_status,
      result = p_result,
      error = p_error,
      executed_at = p_executed_at,
      run_id = COALESCE(p_run_id, run_id),
      execution_payload = CASE WHEN p_status = 'pending' THEN NULL ELSE execution_payload END,
      execution_id = CASE WHEN p_status = 'pending' THEN NULL ELSE execution_id END
  WHERE id = p_task_id
    AND user_id = p_user_id
    AND status = p_expected_status
    AND execution_id = p_execution_id
    AND (auth.role() = 'service_role' OR auth.uid() = p_user_id)
  RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_desk_task_run_id(
  p_task_id UUID,
  p_user_id UUID,
  p_execution_id UUID,
  p_run_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected INTEGER;
BEGIN
  UPDATE public.desk_tasks
  SET run_id = p_run_id
  WHERE id = p_task_id
    AND user_id = p_user_id
    AND status = 'executing'
    AND execution_id = p_execution_id
    AND (auth.role() = 'service_role' OR auth.uid() = p_user_id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

DROP POLICY IF EXISTS "Users can insert own desk tasks" ON public.desk_tasks;
DROP POLICY IF EXISTS "Users can update own desk tasks" ON public.desk_tasks;
REVOKE INSERT, UPDATE ON public.desk_tasks FROM authenticated;

REVOKE ALL ON FUNCTION public.replace_agent_tool_assignments(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_agent_tool_assignments(UUID, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.claim_desk_task_execution(UUID, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_desk_task_execution(UUID, UUID, JSONB) TO authenticated;
REVOKE ALL ON FUNCTION public.transition_desk_task_execution(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_desk_task_execution(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_desk_task_run_id(UUID, UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_desk_task_run_id(UUID, UUID, UUID, TEXT) TO authenticated, service_role;
