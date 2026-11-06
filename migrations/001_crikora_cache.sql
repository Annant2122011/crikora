CREATE TABLE IF NOT EXISTS public.crikora_cache (
  entity_type text NOT NULL CHECK (entity_type IN ('match','player','team','series','venue','competition','ranking','metadata')),
  source_id text NOT NULL,
  source_url text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, source_id),
  CHECK (expires_at > fetched_at)
);

CREATE INDEX IF NOT EXISTS crikora_cache_expiry_idx
  ON public.crikora_cache (expires_at);

CREATE INDEX IF NOT EXISTS crikora_cache_type_expiry_idx
  ON public.crikora_cache (entity_type, expires_at);
