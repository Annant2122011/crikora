-- Stage 1: compact match summaries, transient live state and URL-only player directory.
-- This migration is additive. It deliberately does not delete legacy profile, news,
-- match-detail, cache, snapshot or object-storage data.

CREATE TABLE IF NOT EXISTS public.crikora_player_urls (
  source_id text PRIMARY KEY,
  profile_url text NOT NULL UNIQUE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crikora_player_urls_profile_url_check
    CHECK (profile_url ~ '^https://www\.cricbuzz\.com/profiles/[0-9]+/[^?#]+/?$')
);

CREATE INDEX IF NOT EXISTS crikora_player_urls_last_seen_idx
  ON public.crikora_player_urls (last_seen_at DESC, source_id);

CREATE TABLE IF NOT EXISTS public.crikora_match_summaries (
  match_source_id text PRIMARY KEY,
  source_url text NOT NULL,
  competition text NOT NULL DEFAULT 'Cricket',
  season text,
  gender text NOT NULL DEFAULT 'unknown'
    CHECK (gender IN ('men', 'women', 'mixed', 'unknown')),
  age_group text NOT NULL DEFAULT 'senior',
  format text NOT NULL DEFAULT 'Unknown',
  home_team text NOT NULL,
  away_team text NOT NULL,
  status text NOT NULL CHECK (status IN ('upcoming', 'live', 'completed')),
  start_time timestamptz,
  venue text,
  toss_text text,
  toss_winner text,
  toss_decision text CHECK (toss_decision IS NULL OR toss_decision IN ('bat', 'bowl', 'unknown')),
  result text,
  winner text,
  victory_margin text,
  player_of_match text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crikora_match_summaries_status_start_idx
  ON public.crikora_match_summaries (status, start_time DESC, match_source_id);

CREATE INDEX IF NOT EXISTS crikora_match_summaries_competition_idx
  ON public.crikora_match_summaries (competition, start_time DESC);

CREATE INDEX IF NOT EXISTS crikora_match_summaries_team_idx
  ON public.crikora_match_summaries (home_team, away_team, start_time DESC);

CREATE TABLE IF NOT EXISTS public.crikora_match_summary_innings (
  match_source_id text NOT NULL
    REFERENCES public.crikora_match_summaries(match_source_id) ON DELETE CASCADE,
  innings_number smallint NOT NULL CHECK (innings_number > 0),
  batting_team text,
  runs integer CHECK (runs IS NULL OR runs >= 0),
  wickets smallint CHECK (wickets IS NULL OR wickets BETWEEN 0 AND 10),
  overs text,
  all_out boolean NOT NULL DEFAULT false,
  declared boolean NOT NULL DEFAULT false,
  PRIMARY KEY (match_source_id, innings_number)
);

CREATE INDEX IF NOT EXISTS crikora_match_summary_innings_team_idx
  ON public.crikora_match_summary_innings (batting_team, match_source_id);

CREATE TABLE IF NOT EXISTS public.crikora_live_match_state (
  match_source_id text PRIMARY KEY
    REFERENCES public.crikora_match_summaries(match_source_id) ON DELETE CASCADE,
  compact_state jsonb NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crikora_live_match_state_compact_size_check
    CHECK (pg_column_size(compact_state) <= 32768)
);

CREATE INDEX IF NOT EXISTS crikora_live_match_state_last_seen_idx
  ON public.crikora_live_match_state (last_seen_at DESC);

-- Preserve only the URL directory from legacy player projections. No name,
-- profile field, statistic or source-page body is copied into the new table.
INSERT INTO public.crikora_player_urls (source_id, profile_url, first_seen_at, last_seen_at)
SELECT source_id, source_url, now(), now()
FROM (
  SELECT source_id, source_url FROM public.crikora_player_profiles
  UNION ALL
  SELECT source_id, source_url FROM public.crikora_cache WHERE entity_type='player'
  UNION ALL
  SELECT source_id, source_url FROM public.crikora_entity_snapshots WHERE entity_type='player'
  UNION ALL
  SELECT source_id, source_url FROM public.crikora_source_page_snapshots WHERE entity_type='player'
) AS known_player_urls
WHERE source_id ~ '^[0-9]+$'
  AND source_url ~ '^https://www\\.cricbuzz\\.com/profiles/[0-9]+/[^?#]+/?$'
ON CONFLICT (source_id) DO UPDATE SET
  profile_url=EXCLUDED.profile_url,
  last_seen_at=now();

-- Backfill a compact historical score summary from existing match cache rows.
-- The selected columns intentionally exclude batting/bowling rows, commentary,
-- deliveries, squads, raw HTML, RSC content and all other detailed payload fields.
INSERT INTO public.crikora_match_summaries
  (match_source_id,source_url,competition,gender,age_group,format,home_team,away_team,
   status,start_time,venue,toss_text,toss_winner,toss_decision,result,winner,victory_margin,
   player_of_match,observed_at,completed_at,updated_at)
SELECT
  source_id,
  source_url,
  COALESCE(payload->>'competition','Cricket'),
  CASE
    WHEN COALESCE(payload->>'competition','') ~* 'women|womens|\\mWPL\\M|\\mWBBL\\M' THEN 'women'
    WHEN COALESCE(payload->>'competition','') ~* '\\mmen\\M|mens' THEN 'men'
    ELSE 'unknown'
  END,
  CASE
    WHEN COALESCE(payload->>'competition','') ~* '\\m(?:u|under)[ -]?(11|13|15|16|17|19|21|23)\\M'
      THEN 'u' || (regexp_match(lower(COALESCE(payload->>'competition','')), '\\m(?:u|under)[ -]?(11|13|15|16|17|19|21|23)\\M'))[1]
    WHEN COALESCE(payload->>'competition','') ~* '\\memerging\\M' THEN 'emerging'
    WHEN COALESCE(payload->>'competition','') ~* '\\myouth\\M' THEN 'youth'
    ELSE 'senior'
  END,
  COALESCE(payload->>'format','Unknown'),
  COALESCE(payload->>'homeTeam','Unknown'),
  COALESCE(payload->>'awayTeam','Unknown'),
  payload->>'status',
  CASE WHEN COALESCE(payload->>'startTime','') ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (payload->>'startTime')::timestamptz ELSE NULL END,
  payload->>'venue',
  payload->>'toss',
  CASE
    WHEN COALESCE(payload->>'toss','') ~* 'won the toss' THEN substring(payload->>'toss' FROM '^(.+?)\\s+(won|wins)\\s+the\\s+toss')
    ELSE NULL
  END,
  CASE
    WHEN COALESCE(payload->>'toss','') ~* '(elected|opted|chose|decided)\\s+to\\s+bat' THEN 'bat'
    WHEN COALESCE(payload->>'toss','') ~* '(elected|opted|chose|decided)\\s+to\\s+(bowl|field)' THEN 'bowl'
    ELSE NULL
  END,
  payload->>'result',
  CASE WHEN COALESCE(payload->>'result','') ~* 'won by' THEN substring(payload->>'result' FROM '^(.+?)\\s+won\\s+by') ELSE NULL END,
  CASE WHEN COALESCE(payload->>'result','') ~* 'won by' THEN substring(payload->>'result' FROM 'won\\s+by\\s+(.+)$') ELSE NULL END,
  COALESCE(payload->>'playerOfMatch',payload->>'playerOfTheMatch'),
  fetched_at,
  CASE WHEN payload->>'status'='completed' THEN fetched_at ELSE NULL END,
  now()
FROM public.crikora_cache
WHERE entity_type='match'
  AND payload->>'status' IN ('upcoming','live','completed')
  AND COALESCE(payload->>'homeTeam','') <> ''
  AND COALESCE(payload->>'awayTeam','') <> ''
  AND COALESCE(payload->>'startTime','') ~ '^\\d{4}-\\d{2}-\\d{2}'
  AND substring(payload->>'startTime' FROM 1 FOR 10)::date >= DATE '2026-11-04'
ON CONFLICT (match_source_id) DO NOTHING;

INSERT INTO public.crikora_match_summary_innings
  (match_source_id,innings_number,batting_team,runs,wickets,overs,all_out,declared)
SELECT
  cache.source_id,
  innings.ordinality::smallint,
  innings.value->>'teamName',
  CASE WHEN COALESCE(innings.value->>'runs','') ~ '^\\d+$' THEN (innings.value->>'runs')::integer ELSE NULL END,
  CASE WHEN COALESCE(innings.value->>'wickets','') ~ '^\\d+$' THEN (innings.value->>'wickets')::smallint ELSE NULL END,
  innings.value->>'overs',
  COALESCE(innings.value->>'wickets','')='10' OR COALESCE(innings.value->>'allOut','false')='true',
  COALESCE(innings.value->>'declared','false')='true'
FROM public.crikora_cache AS cache
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(cache.payload->'innings')='array' THEN cache.payload->'innings' ELSE '[]'::jsonb END
) WITH ORDINALITY AS innings(value, ordinality)
JOIN public.crikora_match_summaries AS summary
  ON summary.match_source_id=cache.source_id AND summary.status='completed'
WHERE cache.entity_type='match'
  AND cache.payload->>'status'='completed'
  AND COALESCE(cache.payload->>'startTime','') ~ '^\\d{4}-\\d{2}-\\d{2}'
  AND substring(cache.payload->>'startTime' FROM 1 FOR 10)::date >= DATE '2026-11-04'
ON CONFLICT (match_source_id,innings_number) DO NOTHING;
