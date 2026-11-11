-- Targeted Crikora prototype: preserve prior full-sitemap queue history,
-- but label the new, intentionally scoped queue independently.
ALTER TABLE public.crikora_crawl_runs
  ADD COLUMN IF NOT EXISTS collection_scope text NOT NULL DEFAULT 'legacy-full-sitemap';

ALTER TABLE public.crikora_crawl_runs
  DROP CONSTRAINT IF EXISTS crikora_crawl_runs_collection_scope_check;

ALTER TABLE public.crikora_crawl_runs
  ADD CONSTRAINT crikora_crawl_runs_collection_scope_check
  CHECK (collection_scope IN ('legacy-full-sitemap', 'targeted-product'));

CREATE INDEX IF NOT EXISTS crikora_crawl_runs_scope_status_idx
  ON public.crikora_crawl_runs (collection_scope, status, created_at DESC);

-- Normalized, fully readable news article projection.
CREATE TABLE IF NOT EXISTS public.crikora_news_articles (
  source_id text PRIMARY KEY,
  source_url text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  summary text,
  body_text text NOT NULL DEFAULT '',
  author text,
  category text,
  published_at timestamptz,
  modified_at timestamptz,
  primary_image_url text,
  tags text[] NOT NULL DEFAULT '{}',
  raw_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crikora_news_articles_published_idx
  ON public.crikora_news_articles (published_at DESC NULLS LAST, source_id);
CREATE INDEX IF NOT EXISTS crikora_news_articles_category_idx
  ON public.crikora_news_articles (category, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS crikora_news_articles_search_idx
  ON public.crikora_news_articles USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(body_text,'')));

-- Match fixtures from schedule / series pages. Match details remain in the
-- canonical crikora_match* tables; this is the schedule read model.
CREATE TABLE IF NOT EXISTS public.crikora_schedule_fixtures (
  fixture_source_id text PRIMARY KEY,
  match_source_id text NOT NULL,
  source_page_url text NOT NULL,
  match_url text NOT NULL,
  match_title text NOT NULL,
  home_team text,
  away_team text,
  competition text NOT NULL,
  format text NOT NULL,
  start_time timestamptz,
  venue text,
  source_text text NOT NULL DEFAULT '',
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crikora_schedule_fixtures_start_idx
  ON public.crikora_schedule_fixtures (start_time ASC NULLS LAST, fixture_source_id);
CREATE INDEX IF NOT EXISTS crikora_schedule_fixtures_team_idx
  ON public.crikora_schedule_fixtures (home_team, away_team, start_time);
CREATE INDEX IF NOT EXISTS crikora_schedule_fixtures_competition_idx
  ON public.crikora_schedule_fixtures (competition, start_time);
