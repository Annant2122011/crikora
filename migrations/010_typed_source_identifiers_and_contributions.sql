-- Additional typed source identifiers and contribution detail.
-- Apply after 009_delivery_extra_breakdown.sql.
ALTER TABLE public.crikora_player_statistics
  ADD COLUMN IF NOT EXISTS source_path text;

ALTER TABLE public.crikora_match_deliveries
  ADD COLUMN IF NOT EXISTS batter_source_id text,
  ADD COLUMN IF NOT EXISTS non_striker_source_id text,
  ADD COLUMN IF NOT EXISTS bowler_source_id text,
  ADD COLUMN IF NOT EXISTS dismissed_player_source_id text,
  ADD COLUMN IF NOT EXISTS fielder_source_id text;

ALTER TABLE public.crikora_match_partnerships
  ADD COLUMN IF NOT EXISTS batter_one_source_id text,
  ADD COLUMN IF NOT EXISTS batter_one_runs integer CHECK (batter_one_runs IS NULL OR batter_one_runs >= 0),
  ADD COLUMN IF NOT EXISTS batter_one_balls integer CHECK (batter_one_balls IS NULL OR batter_one_balls >= 0),
  ADD COLUMN IF NOT EXISTS batter_two_source_id text,
  ADD COLUMN IF NOT EXISTS batter_two_runs integer CHECK (batter_two_runs IS NULL OR batter_two_runs >= 0),
  ADD COLUMN IF NOT EXISTS batter_two_balls integer CHECK (batter_two_balls IS NULL OR batter_two_balls >= 0);

ALTER TABLE public.crikora_match_fall_of_wickets
  ADD COLUMN IF NOT EXISTS player_source_id text;

CREATE INDEX IF NOT EXISTS crikora_match_deliveries_batter_idx
  ON public.crikora_match_deliveries (batter_source_id, observed_at DESC)
  WHERE batter_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crikora_match_deliveries_bowler_idx
  ON public.crikora_match_deliveries (bowler_source_id, observed_at DESC)
  WHERE bowler_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crikora_match_partnership_batter_one_idx
  ON public.crikora_match_partnerships (batter_one_source_id, observed_at DESC)
  WHERE batter_one_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crikora_match_partnership_batter_two_idx
  ON public.crikora_match_partnerships (batter_two_source_id, observed_at DESC)
  WHERE batter_two_source_id IS NOT NULL;
