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
