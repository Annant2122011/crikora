-- Typed, queryable current projections for Cricbuzz player profiles and match detail.
-- Historical truth remains in the append-only entity snapshots and raw source-page archive.
CREATE TABLE IF NOT EXISTS public.crikora_player_profiles (
  source_id text PRIMARY KEY,
  source_url text NOT NULL,
  full_name text,
  country text,
  role text,
  batting_style text,
  bowling_style text,
  birth_date date,
  birth_place text,
  height_cm numeric(6,2),
  biography text,
  profile_image_url text,
  teams text[] NOT NULL DEFAULT '{}',
  profile_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crikora_player_profiles_height_check CHECK (height_cm IS NULL OR height_cm BETWEEN 50 AND 300)
);

CREATE TABLE IF NOT EXISTS public.crikora_player_profile_attributes (
  source_id text NOT NULL REFERENCES public.crikora_player_profiles(source_id) ON DELETE CASCADE,
  field_path text NOT NULL,
  source_label text NOT NULL,
  section text,
  value_type text NOT NULL CHECK (value_type IN ('text','numeric','date','boolean','json')),
  value_text text,
  value_numeric numeric,
  value_date date,
  value_boolean boolean,
  value_json jsonb,
  ordinal integer NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, field_path, ordinal),
  CHECK (
    (value_type = 'text' AND value_text IS NOT NULL) OR
    (value_type = 'numeric' AND value_numeric IS NOT NULL) OR
    (value_type = 'date' AND value_date IS NOT NULL) OR
    (value_type = 'boolean' AND value_boolean IS NOT NULL) OR
    (value_type = 'json' AND value_json IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS crikora_player_profile_attributes_label_idx
  ON public.crikora_player_profile_attributes (source_label);

CREATE TABLE IF NOT EXISTS public.crikora_player_statistics (
  source_id text NOT NULL REFERENCES public.crikora_player_profiles(source_id) ON DELETE CASCADE,
  table_index integer NOT NULL,
  row_index integer NOT NULL,
  section text,
  row_label text,
  metric_label text NOT NULL,
  metric_key text NOT NULL,
  value_text text NOT NULL,
  value_numeric numeric,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, table_index, row_index, metric_key)
);
CREATE INDEX IF NOT EXISTS crikora_player_statistics_lookup_idx
  ON public.crikora_player_statistics (source_id, metric_key, value_numeric);

CREATE TABLE IF NOT EXISTS public.crikora_match_innings (
  match_source_id text NOT NULL,
  innings_number smallint NOT NULL CHECK (innings_number > 0),
  team_name text,
  runs integer CHECK (runs IS NULL OR runs >= 0),
  wickets smallint CHECK (wickets IS NULL OR wickets BETWEEN 0 AND 10),
  overs text,
  extras_total integer NOT NULL DEFAULT 0 CHECK (extras_total >= 0),
  byes integer NOT NULL DEFAULT 0 CHECK (byes >= 0),
  leg_byes integer NOT NULL DEFAULT 0 CHECK (leg_byes >= 0),
  wides integer NOT NULL DEFAULT 0 CHECK (wides >= 0),
  no_balls integer NOT NULL DEFAULT 0 CHECK (no_balls >= 0),
  penalty integer NOT NULL DEFAULT 0 CHECK (penalty >= 0),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_source_id, innings_number)
);

CREATE TABLE IF NOT EXISTS public.crikora_match_batting (
  match_source_id text NOT NULL,
  innings_number smallint NOT NULL,
  player_source_id text,
  player_name text NOT NULL,
  dismissal text,
  runs integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  balls integer NOT NULL DEFAULT 0 CHECK (balls >= 0),
  fours integer NOT NULL DEFAULT 0 CHECK (fours >= 0),
  sixes integer NOT NULL DEFAULT 0 CHECK (sixes >= 0),
  strike_rate numeric(8,2),
  not_out boolean NOT NULL DEFAULT false,
  batting_position smallint NOT NULL,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_source_id, innings_number, batting_position)
);
CREATE INDEX IF NOT EXISTS crikora_match_batting_player_idx
  ON public.crikora_match_batting (player_source_id, observed_at DESC)
  WHERE player_source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.crikora_match_bowling (
  match_source_id text NOT NULL,
  innings_number smallint NOT NULL,
  player_source_id text,
  player_name text NOT NULL,
  overs text NOT NULL,
  maidens integer NOT NULL DEFAULT 0 CHECK (maidens >= 0),
  runs integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  wickets integer NOT NULL DEFAULT 0 CHECK (wickets >= 0),
  no_balls integer NOT NULL DEFAULT 0 CHECK (no_balls >= 0),
  wides integer NOT NULL DEFAULT 0 CHECK (wides >= 0),
  economy numeric(8,2),
  bowling_position smallint NOT NULL,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_source_id, innings_number, bowling_position)
);

CREATE TABLE IF NOT EXISTS public.crikora_match_partnerships (
  match_source_id text NOT NULL,
  innings_number smallint NOT NULL,
  partnership_number smallint NOT NULL,
  batter_one text,
  batter_two text,
  runs integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  balls integer CHECK (balls IS NULL OR balls >= 0),
  description text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_source_id, innings_number, partnership_number)
);

CREATE TABLE IF NOT EXISTS public.crikora_match_fall_of_wickets (
  match_source_id text NOT NULL,
  innings_number smallint NOT NULL,
  wicket_number smallint NOT NULL,
  score integer,
  batter_name text,
  over text,
  description text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_source_id, innings_number, wicket_number)
);

CREATE TABLE IF NOT EXISTS public.crikora_match_deliveries (
  match_source_id text NOT NULL,
  source_event_id text NOT NULL,
  innings_number smallint NOT NULL,
  over_number numeric(5,2),
  ball_number smallint,
  batter text,
  non_striker text,
  bowler text,
  bat_runs smallint NOT NULL DEFAULT 0,
  extra_runs smallint NOT NULL DEFAULT 0,
  total_runs smallint NOT NULL DEFAULT 0,
  extra_type text,
  is_wicket boolean NOT NULL DEFAULT false,
  dismissal_type text,
  dismissed_player text,
  fielder text,
  description text,
  commentary text,
  event_type text,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_source_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS crikora_match_deliveries_order_idx
  ON public.crikora_match_deliveries (match_source_id, innings_number, over_number, ball_number);

CREATE TABLE IF NOT EXISTS public.crikora_match_commentary (
  match_source_id text NOT NULL,
  source_event_id text NOT NULL,
  innings_number smallint NOT NULL,
  over_number numeric(5,2),
  ball_number smallint,
  event_type text,
  batter text,
  bowler text,
  description text,
  commentary text NOT NULL,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_source_id, source_event_id)
);
CREATE INDEX IF NOT EXISTS crikora_match_commentary_order_idx
  ON public.crikora_match_commentary (match_source_id, innings_number, over_number, ball_number);

CREATE INDEX IF NOT EXISTS crikora_match_innings_observed_idx
  ON public.crikora_match_innings (match_source_id, observed_at DESC);
