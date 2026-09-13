-- =============================================================================
-- Migration: Add TikTok & Pinterest support to Social Posts
-- Purpose: Schema updates for TikTok (via Buffer) and Pinterest (via Composio MCP)
-- =============================================================================

-- 1. Add TikTok and Pinterest columns to main social_posts table
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS tiktok TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_data JSONB,
  ADD COLUMN IF NOT EXISTS pinterest TEXT,
  ADD COLUMN IF NOT EXISTS pinterest_data JSONB;

-- 2. Specialized table for TikTok posts
CREATE TABLE IF NOT EXISTS public.social_tiktok_posts (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id             UUID        REFERENCES public.social_posts(id) ON DELETE CASCADE,
  user_id             UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  text                TEXT,
  video_url           TEXT,
  title               TEXT,
  status              TEXT        NOT NULL DEFAULT 'draft',
  published_post_id   TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS social_tiktok_posts_post_id_idx
  ON public.social_tiktok_posts (post_id);

CREATE INDEX IF NOT EXISTS social_tiktok_posts_user_status_idx
  ON public.social_tiktok_posts (user_id, status, created_at DESC);

-- 3. Specialized table for Pinterest posts / pins
CREATE TABLE IF NOT EXISTS public.social_pinterest_posts (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  post_id             UUID        REFERENCES public.social_posts(id) ON DELETE CASCADE,
  user_id             UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  title               TEXT,
  description         TEXT,
  link                TEXT,
  media_url           TEXT,
  board_id            TEXT,
  status              TEXT        NOT NULL DEFAULT 'draft',
  published_pin_id    TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS social_pinterest_posts_post_id_idx
  ON public.social_pinterest_posts (post_id);

CREATE INDEX IF NOT EXISTS social_pinterest_posts_user_status_idx
  ON public.social_pinterest_posts (user_id, status, created_at DESC);

-- 4. Enable RLS
ALTER TABLE public.social_tiktok_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_pinterest_posts ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies
CREATE POLICY "Users can manage their own tiktok posts"
  ON public.social_tiktok_posts
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access to tiktok posts"
  ON public.social_tiktok_posts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can manage their own pinterest posts"
  ON public.social_pinterest_posts
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access to pinterest posts"
  ON public.social_pinterest_posts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
