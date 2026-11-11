-- Per-delivery extras are queryable independently from the innings aggregate.
-- Run after 008_typed_cricket_projections.sql.
ALTER TABLE public.crikora_match_deliveries
  ADD COLUMN IF NOT EXISTS byes smallint NOT NULL DEFAULT 0 CHECK (byes >= 0),
  ADD COLUMN IF NOT EXISTS leg_byes smallint NOT NULL DEFAULT 0 CHECK (leg_byes >= 0),
  ADD COLUMN IF NOT EXISTS wides smallint NOT NULL DEFAULT 0 CHECK (wides >= 0),
  ADD COLUMN IF NOT EXISTS no_balls smallint NOT NULL DEFAULT 0 CHECK (no_balls >= 0),
  ADD COLUMN IF NOT EXISTS penalty smallint NOT NULL DEFAULT 0 CHECK (penalty >= 0);
