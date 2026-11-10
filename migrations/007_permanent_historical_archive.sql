-- Reconcile classified-cache schema before the archive starts writing snapshots.
-- This is safe whether migration 006 was applied previously or not.
ALTER TABLE public.crikora_cache
  ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE public.crikora_cache
  ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'ephemeral';

ALTER TABLE public.crikora_cache
  DROP CONSTRAINT IF EXISTS crikora_cache_check;

ALTER TABLE public.crikora_cache
  DROP CONSTRAINT IF EXISTS crikora_cache_expiry_check;

ALTER TABLE public.crikora_cache
  ADD CONSTRAINT crikora_cache_expiry_check
  CHECK (expires_at IS NULL OR expires_at > fetched_at);

ALTER TABLE public.crikora_cache
  DROP CONSTRAINT IF EXISTS crikora_cache_retention_class_check;

ALTER TABLE public.crikora_cache
  ADD CONSTRAINT crikora_cache_retention_class_check
  CHECK (retention_class IN ('ephemeral', 'persistent'));

UPDATE public.crikora_cache
SET retention_class = CASE
      WHEN entity_type = 'match'
        AND COALESCE(payload->>'status', 'live') NOT IN ('upcoming', 'completed')
        THEN 'ephemeral'
      WHEN entity_type = 'ranking'
        THEN 'ephemeral'
      WHEN entity_type = 'metadata'
        AND COALESCE(payload->>'pageKind', '') = ANY (ARRAY[
          'player-stats', 'ranking-or-statistics', 'match-scorecard', 'commentary',
          'live-stream-page', 'live-graphs', 'over-by-over', 'player-match-performance',
          'match-forecast', 'wicket-zone'
        ])
        THEN 'ephemeral'
      ELSE 'persistent'
    END,
    expires_at = CASE
      WHEN (
        (entity_type = 'match' AND COALESCE(payload->>'status', 'live') NOT IN ('upcoming', 'completed'))
        OR entity_type = 'ranking'
        OR (
          entity_type = 'metadata'
          AND COALESCE(payload->>'pageKind', '') = ANY (ARRAY[
            'player-stats', 'ranking-or-statistics', 'match-scorecard', 'commentary',
            'live-stream-page', 'live-graphs', 'over-by-over', 'player-match-performance',
            'match-forecast', 'wicket-zone'
          ])
        )
      )
      THEN COALESCE(expires_at, fetched_at + INTERVAL '10 minutes')
      ELSE NULL
    END,
    updated_at = now();

-- Permanent, versioned historical archive.
-- Unlike crikora_cache, these tables are append-only and are never TTL-cleaned.
CREATE TABLE IF NOT EXISTS public.crikora_entity_snapshots (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('match','player','team','series','venue','competition','ranking','metadata')),
  source_id text NOT NULL,
  source_url text NOT NULL,
  payload_hash char(64) NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crikora_entity_snapshots_history_idx
  ON public.crikora_entity_snapshots (entity_type, source_id, observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crikora_entity_snapshots_hash_idx
  ON public.crikora_entity_snapshots (entity_type, source_id, payload_hash);
CREATE INDEX IF NOT EXISTS crikora_entity_snapshots_observed_idx
  ON public.crikora_entity_snapshots (observed_at DESC);
CREATE INDEX IF NOT EXISTS crikora_entity_snapshots_source_url_idx
  ON public.crikora_entity_snapshots (source_url, id DESC);

CREATE TABLE IF NOT EXISTS public.crikora_source_page_snapshots (
  id bigserial PRIMARY KEY,
  source_url text NOT NULL,
  page_kind text NOT NULL,
  entity_type text,
  source_id text,
  content_type text NOT NULL DEFAULT 'text/html; charset=utf-8',
  content_sha256 char(64) NOT NULL,
  body_gzip bytea,
  object_key text,
  body_bytes integer NOT NULL CHECK (body_bytes >= 0),
  stored_bytes integer NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Old development captures may remain in bytea; new production captures use
-- a private S3 object key so large historical HTML does not consume PG storage.
ALTER TABLE public.crikora_source_page_snapshots
  ADD COLUMN IF NOT EXISTS object_key text;

ALTER TABLE public.crikora_source_page_snapshots
  ADD COLUMN IF NOT EXISTS stored_bytes integer NOT NULL DEFAULT 0;

UPDATE public.crikora_source_page_snapshots
SET stored_bytes = octet_length(body_gzip)
WHERE body_gzip IS NOT NULL AND stored_bytes = 0;

ALTER TABLE public.crikora_source_page_snapshots
  DROP CONSTRAINT IF EXISTS crikora_source_page_snapshots_stored_bytes_check;

ALTER TABLE public.crikora_source_page_snapshots
  ADD CONSTRAINT crikora_source_page_snapshots_stored_bytes_check
  CHECK (stored_bytes >= 0);

ALTER TABLE public.crikora_source_page_snapshots
  ALTER COLUMN body_gzip DROP NOT NULL;

ALTER TABLE public.crikora_source_page_snapshots
  DROP CONSTRAINT IF EXISTS crikora_source_page_snapshots_storage_location_check;

ALTER TABLE public.crikora_source_page_snapshots
  ADD CONSTRAINT crikora_source_page_snapshots_storage_location_check
  CHECK ((body_gzip IS NULL) <> (object_key IS NULL));

CREATE INDEX IF NOT EXISTS crikora_source_page_snapshots_object_key_idx
  ON public.crikora_source_page_snapshots (object_key)
  WHERE object_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS crikora_source_page_snapshots_url_idx
  ON public.crikora_source_page_snapshots (source_url, fetched_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS crikora_source_page_snapshots_hash_idx
  ON public.crikora_source_page_snapshots (source_url, content_sha256);
CREATE INDEX IF NOT EXISTS crikora_source_page_snapshots_kind_idx
  ON public.crikora_source_page_snapshots (page_kind, fetched_at DESC);
CREATE INDEX IF NOT EXISTS crikora_source_page_snapshots_fetched_idx
  ON public.crikora_source_page_snapshots (fetched_at DESC);

CREATE TABLE IF NOT EXISTS public.crikora_archive_coverage (
  source_url text PRIMARY KEY,
  identity_key text NOT NULL,
  page_kind text NOT NULL,
  status text NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered','pending','processing','captured','skipped','failed')),
  first_discovered_at timestamptz NOT NULL DEFAULT now(),
  last_discovered_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  last_fetched_at timestamptz,
  last_http_status integer,
  last_content_sha256 char(64),
  fetch_count bigint NOT NULL DEFAULT 0 CHECK (fetch_count >= 0),
  version_count bigint NOT NULL DEFAULT 0 CHECK (version_count >= 0),
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crikora_archive_coverage_status_idx
  ON public.crikora_archive_coverage (status, page_kind, last_discovered_at DESC);
CREATE INDEX IF NOT EXISTS crikora_archive_coverage_identity_idx
  ON public.crikora_archive_coverage (identity_key);

-- Keep the evidence tables immutable at the database boundary.
CREATE OR REPLACE FUNCTION public.crikora_reject_archive_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Crikora archive evidence is append-only; % is not permitted on %', TG_OP, TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS crikora_entity_snapshots_immutable ON public.crikora_entity_snapshots;
CREATE TRIGGER crikora_entity_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.crikora_entity_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.crikora_reject_archive_mutation();

DROP TRIGGER IF EXISTS crikora_source_page_snapshots_immutable ON public.crikora_source_page_snapshots;
CREATE TRIGGER crikora_source_page_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.crikora_source_page_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.crikora_reject_archive_mutation();
