ALTER TABLE public.crikora_cache
  ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE public.crikora_cache
  ADD COLUMN IF NOT EXISTS retention_class text NOT NULL DEFAULT 'ephemeral';

ALTER TABLE public.crikora_cache
  DROP CONSTRAINT IF EXISTS crikora_cache_check;

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
          'player-stats',
          'ranking-or-statistics',
          'match-scorecard',
          'commentary',
          'live-stream-page',
          'live-graphs',
          'over-by-over',
          'player-match-performance',
          'match-forecast',
          'wicket-zone'
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
            'player-stats',
            'ranking-or-statistics',
            'match-scorecard',
            'commentary',
            'live-stream-page',
            'live-graphs',
            'over-by-over',
            'player-match-performance',
            'match-forecast',
            'wicket-zone'
          ])
        )
      )
      THEN COALESCE(expires_at, fetched_at + INTERVAL '10 minutes')
      ELSE NULL
    END,
    updated_at = now();
