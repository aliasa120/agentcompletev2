-- ============================================================
-- Skills System Migration — Run in Supabase SQL Editor
-- ============================================================

-- Add new columns for Hermes-style skill management
ALTER TABLE skills_library ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
ALTER TABLE skills_library ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'active';
ALTER TABLE skills_library ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE skills_library ADD COLUMN IF NOT EXISTS use_count INTEGER DEFAULT 0;
ALTER TABLE skills_library ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE skills_library ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT 'user';

-- Indexes for fast filtering
CREATE INDEX IF NOT EXISTS idx_skills_state ON skills_library(state);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills_library(category);

-- Seed 4 sample skills (skip if already exist)
INSERT INTO skills_library (skill_key, label, description, content, source, category, state, created_by)
VALUES
(
  'web_research',
  'Web Research',
  'Systematic web research methodology — search strategies, source evaluation, fact verification, and structured report writing.',
  E'---\nname: web_research\ndescription: >-\n  Systematic web research methodology — search strategies, source\n  evaluation, fact verification, and structured report writing.\ncategory: research\n---\n\n# Web Research Skill\n\n## Overview\nFollow this procedure for any research task that requires finding factual information online.\n\n## Step 1 — Query Design\n- Write 4-8 keyword queries (no quotes, no full sentences)\n- Always include the year for current events\n- Use proper nouns and official terminology\n- BAD: "What happened with the economy?"\n- GOOD: Pakistan GDP growth rate 2026 Q1\n\n## Step 2 — Source Evaluation\nPrioritize sources in this order:\n1. Official government sites (.gov.pk, .gov)\n2. Wire agencies (Reuters, AP, AFP)\n3. Major outlets (Dawn, BBC, Al Jazeera, Bloomberg)\n4. Regional outlets (Geo, ARY, Tribune)\n5. Trade publications and academic sources\n\nAvoid: blogs, forums, social media posts, Wikipedia (as primary source)\n\n## Step 3 — Fact Verification\n- Every key claim needs 2+ independent sources\n- Cross-check numbers/statistics against official releases\n- Note any conflicting information between sources\n- Flag unverified claims clearly\n\n## Step 4 — Report Structure\n```\n## Research Report\n**Topic:** [topic]\n**Date:** [date]\n\n### Key Findings\n- [Finding 1 + source]\n- [Finding 2 + source]\n\n### Detailed Analysis\n[Organized by theme/subtopic]\n\n### Sources\n[1] [Source]: [URL]\n```\n\n## Pitfalls\n- Dont reuse failed queries — always rephrase\n- Max 3 search rounds per topic\n- Extract URLs only from credible domains\n- Never fabricate sources or quotes',
  'system', 'research', 'active', 'system'
),
(
  'seo_optimizer',
  'SEO Optimizer',
  'On-page SEO optimization — keyword placement, meta tags, heading structure, internal linking, and featured snippet targeting.',
  E'---\nname: seo_optimizer\ndescription: >-\n  On-page SEO optimization — keyword placement, meta tags, heading\n  structure, internal linking, and featured snippet targeting.\ncategory: content\n---\n\n# SEO Optimizer Skill\n\n## When to Use\nApply this skill after writing any content that will be published on the web.\n\n## Keyword Strategy\n1. Identify 1 primary keyword (2-4 words) and 2-3 secondary keywords\n2. Place primary keyword in:\n   - Title tag (first 60 chars)\n   - H1 heading\n   - First paragraph\n   - One H2 subheading\n   - Meta description\n   - URL slug\n3. Place secondary keywords naturally in body and remaining H2/H3 headings\n4. Keyword density: 1-2% for primary, 0.5-1% for secondary\n\n## Meta Tags\n- **Title tag:** 50-60 characters, keyword near front, compelling\n- **Meta description:** 150-160 characters, includes keyword, has CTA\n- **URL slug:** short, hyphenated, includes primary keyword\n\n## Heading Structure\n- One H1 per page (the title)\n- 3-5 H2 sections (main content divisions)\n- H3 for subsections within H2 blocks\n- Include keyword variations in headings\n\n## Content Depth\n- Aim for 1,200-2,000 words for competitive topics\n- Cover related questions (People Also Ask)\n- Include data points, statistics, expert quotes\n- Use structured data: tables, numbered lists, definition paragraphs\n\n## Internal & External Links\n- 2-3 internal links to related content\n- 1-2 external links to authoritative sources\n- Use descriptive anchor text (not "click here")\n\n## Featured Snippet Targeting\n- Answer the primary question in 40-60 words directly after an H2\n- Use numbered lists for "how to" queries\n- Use tables for comparison queries\n- Use definition paragraphs for "what is" queries',
  'system', 'content', 'active', 'system'
),
(
  'social_media_writer',
  'Social Media Writer',
  'Platform-specific social media post creation — hooks, character limits, hashtag strategy, and engagement optimization.',
  E'---\nname: social_media_writer\ndescription: >-\n  Platform-specific social media post creation — hooks, character limits,\n  hashtag strategy, and engagement optimization.\ncategory: content\n---\n\n# Social Media Writer Skill\n\n## When to Use\nApply when creating social media posts for any platform.\n\n## Platform Rules\n\n### X (Twitter)\n- HARD LIMIT: 280 characters total (spaces, emojis, hashtags included)\n- Lead with the most newsworthy fact\n- One hashtag maximum\n- Use active voice, present tense\n- End with a question or bold statement\n- NO links in the main text (link goes in reply)\n\n### Instagram\n- Hook in first line (before "more" cutoff, ~125 chars)\n- Use line breaks for readability\n- Tell a micro-story: hook → context → insight → CTA\n- 5-8 hashtags at the END (mix broad + niche)\n- Emojis: 2-3 max, used for emphasis not decoration\n- End with engagement CTA: "Save this", "Share with someone who..."\n\n### Facebook\n- Conversational, like talking to a friend\n- Lead with the human angle\n- 80-250 words\n- End with a genuine question that drives comments\n- Include source link naturally\n\n## Hook Formulas\n1. **Surprising stat:** "73% of marketers say..."\n2. **Contrarian:** "Everyone thinks X. They are wrong."\n3. **Question:** "What if you could...?"\n4. **Breaking:** "BREAKING: [key fact in 10 words]"\n5. **Story:** "Last week, [relatable scenario]"\n\n## Quality Checklist\n- [ ] Hook grabs attention in first line\n- [ ] At least 1 specific fact (name, date, number)\n- [ ] Source attributed naturally\n- [ ] Platform character limit respected\n- [ ] CTA present\n- [ ] No citation numbers [1][2] in text',
  'system', 'content', 'active', 'system'
),
(
  'wordpress_publishing',
  'WordPress Publishing',
  'End-to-end WordPress publishing workflow — category selection, featured images, post formatting, and link embedding.',
  E'---\nname: wordpress_publishing\ndescription: >-\n  End-to-end WordPress publishing workflow — category selection, featured\n  images, post formatting, and link embedding.\ncategory: publishing\n---\n\n# WordPress Publishing Skill\n\n## When to Use\nApply when publishing any content to WordPress.\n\n## Pre-Publishing Checklist\n1. Blog post has frontmatter (title, slug, meta_description, focus_keyword, category_hint)\n2. Content has proper H2/H3 structure\n3. Images embedded with hosted URLs (never local paths)\n4. No citation numbers [1][2] in body text\n5. Featured image selected\n\n## Category Selection\nMap category_hint to WordPress category:\n| Hint | Category |\n|------|----------|\n| pakistan | pakistan |\n| sports | sports |\n| business | business |\n| tech | technology |\n| latest | latest-news |\n| unknown | latest-news (fallback) |\n\nCall `get_wordpress_categories()` first to get actual category IDs.\n\n## Publishing Steps\n1. `get_wordpress_categories()` → get category ID\n2. Read full `/blog_post.md` content\n3. `publish_to_wordpress(blog_post_markdown=content, category_id=ID, featured_image_path="output/candidate_images/image_1.jpg")`\n4. Capture returned `post_url`\n5. Append post_url to social posts:\n   - Facebook: "Read more: [post_url]"\n   - Instagram: "Full story: [post_url]"\n\n## Image Rules\n- Featured image: `output/candidate_images/image_1.jpg`\n- In-post images: MUST use hosted https:// URLs\n- NEVER use local file paths in blog body\n- Image sizing: append `?w=800` for content width\n\n## Error Handling\n- If WordPress fails: log error, continue pipeline\n- Never halt the entire workflow for a WP failure\n- Always proceed to save_posts_to_supabase regardless',
  'system', 'publishing', 'active', 'system'
)
ON CONFLICT (skill_key) DO NOTHING;

-- Update existing blog_post_writer with new columns
UPDATE skills_library 
SET category = 'content', state = 'active', created_by = 'system'
WHERE skill_key = 'blog_post_writer' AND category IS NULL;

SELECT 'Skills migration complete ✅' AS status;
