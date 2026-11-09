-- Stable entity identity prevents alternate Cricbuzz slugs for the same page
-- from being queued more than once. Distinct page families retain separate keys.
ALTER TABLE public.crikora_crawl_queue
  ADD COLUMN IF NOT EXISTS identity_key text;

WITH classified AS (
  SELECT
    id,
    run_id,
    CASE
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/live-cricket-scores/[0-9]+/'
        THEN 'match:' || (regexp_match(canonical_url, '/live-cricket-scores/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-match-facts/[0-9]+/'
        THEN 'metadata:match-facts:' || (regexp_match(canonical_url, '/cricket-match-facts/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-match-squads/[0-9]+/'
        THEN 'metadata:match-squads:' || (regexp_match(canonical_url, '/cricket-match-squads/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/live-cricket-scorecard/[0-9]+/'
        THEN 'metadata:match-scorecard:' || (regexp_match(canonical_url, '/live-cricket-scorecard/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-news/[0-9]+/'
        THEN 'metadata:news:' || (regexp_match(canonical_url, '/cricket-news/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-videos/collection/[0-9]+/'
        THEN 'metadata:video-collection:' || (regexp_match(canonical_url, '/cricket-videos/collection/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-videos/[0-9]+/'
        THEN 'metadata:video:' || (regexp_match(canonical_url, '/cricket-videos/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-gallery/[0-9]+/'
        THEN 'metadata:gallery:' || (regexp_match(canonical_url, '/cricket-gallery/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/profiles/[0-9]+/[^/]+/(all-matches|batting|bowling|stats)(/|$)'
        THEN 'metadata:player-stats:' ||
          (regexp_match(canonical_url, '/profiles/([0-9]+)/'))[1] || ':' ||
          lower(trim(trailing '/' from regexp_replace(split_part(canonical_url, '?', 1),
            '^https://www[.]cricbuzz[.]com/profiles/[0-9]+/[^/]+/', '')))
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/profiles/[0-9]+/[^/?#]+/?([?#].*)?$'
        THEN 'player:' || (regexp_match(canonical_url, '/profiles/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-team/[^/]+/[0-9]+/.+'
        THEN 'metadata:team-subpage:' ||
          (regexp_match(canonical_url, '/cricket-team/[^/]+/([0-9]+)/'))[1] || ':' ||
          lower(trim(trailing '/' from regexp_replace(split_part(canonical_url, '?', 1),
            '^https://www[.]cricbuzz[.]com/cricket-team/[^/]+/[0-9]+/', '')))
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-team/[^/]+/[0-9]+/?([?#].*)?$'
        THEN 'team:' || (regexp_match(canonical_url, '/cricket-team/[^/]+/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-series/[^/]+/auction(/|$)'
        THEN 'metadata:series-auction:' ||
          (regexp_match(canonical_url, '/cricket-series/([^/]+)/auction'))[1] || ':' ||
          trim(trailing '/' from coalesce((regexp_match(canonical_url, '/auction/([^?#]+)'))[1], 'index'))
      WHEN canonical_url ~ '/venues/[0-9]+(/|[?#]|$)'
        THEN 'venue:' || (regexp_match(canonical_url, '/venues/([0-9]+)'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-series/[0-9]+/[^/]+/.+'
        THEN 'metadata:series-subpage:' ||
          (regexp_match(canonical_url, '/cricket-series/([0-9]+)/'))[1] || ':' ||
          lower(trim(trailing '/' from regexp_replace(split_part(canonical_url, '?', 1),
            '^https://www[.]cricbuzz[.]com/cricket-series/[0-9]+/[^/]+/', '')))
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-series/[0-9]+/[^/?#]+/?([?#].*)?$'
        THEN 'series:' || (regexp_match(canonical_url, '/cricket-series/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/player-match-performance/match/[0-9]+/player/[0-9]+/(batting|bowling)/?([?#].*)?$'
        THEN 'metadata:player-match-performance:' ||
          (regexp_match(canonical_url, '/match/([0-9]+)/player/([0-9]+)/(batting|bowling)'))[1] || ':' ||
          (regexp_match(canonical_url, '/match/([0-9]+)/player/([0-9]+)/(batting|bowling)'))[2] || ':' ||
          (regexp_match(canonical_url, '/match/([0-9]+)/player/([0-9]+)/(batting|bowling)'))[3]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/live-cricket-full-commentary/[0-9]+/'
        THEN 'metadata:commentary:' || (regexp_match(canonical_url, '/live-cricket-full-commentary/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/live-cricket-stream/[0-9]+/'
        THEN 'metadata:live-stream-page:' || (regexp_match(canonical_url, '/live-cricket-stream/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-match-highlights/[0-9]+/'
        THEN 'metadata:match-highlights:' || (regexp_match(canonical_url, '/cricket-match-highlights/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/live-cricket-graphs/[0-9]+/'
        THEN 'metadata:live-graphs:' || (regexp_match(canonical_url, '/live-cricket-graphs/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/special-content/wicket-zone/[0-9]+/'
        THEN 'metadata:wicket-zone:' || (regexp_match(canonical_url, '/wicket-zone/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/cricket-match-forecast/[0-9]+/'
        THEN 'metadata:match-forecast:' || (regexp_match(canonical_url, '/cricket-match-forecast/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/player-match-highlights/[0-9]+/'
        THEN 'metadata:player-match-highlights:' || (regexp_match(canonical_url, '/player-match-highlights/([0-9]+)/'))[1]
      WHEN canonical_url ~ '^https://www[.]cricbuzz[.]com/live-cricket-over-by-over/[0-9]+/'
        THEN 'metadata:over-by-over:' || (regexp_match(canonical_url, '/live-cricket-over-by-over/([0-9]+)/'))[1]
      ELSE 'url:' || canonical_url
    END AS identity_key,
    status,
    created_at
  FROM public.crikora_crawl_queue
),
ranked AS (
  SELECT
    id,
    identity_key,
    row_number() OVER (
      PARTITION BY run_id, identity_key
      ORDER BY
        CASE status WHEN 'completed' THEN 0 WHEN 'processing' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        created_at,
        id
    ) AS identity_rank
  FROM classified
)
UPDATE public.crikora_crawl_queue AS queue
SET
  identity_key = CASE
    WHEN ranked.identity_rank = 1 THEN ranked.identity_key
    ELSE 'duplicate:' || queue.id::text
  END,
  status = CASE WHEN ranked.identity_rank > 1 THEN 'skipped' ELSE queue.status END,
  lease_token = CASE WHEN ranked.identity_rank > 1 THEN NULL ELSE queue.lease_token END,
  lease_until = CASE WHEN ranked.identity_rank > 1 THEN NULL ELSE queue.lease_until END,
  completed_at = CASE WHEN ranked.identity_rank > 1 THEN now() ELSE queue.completed_at END,
  last_error = CASE
    WHEN ranked.identity_rank > 1 THEN 'Skipped duplicate page identity during Stage 2 queue migration.'
    ELSE queue.last_error
  END,
  updated_at = CASE WHEN ranked.identity_rank > 1 THEN now() ELSE queue.updated_at END
FROM ranked
WHERE queue.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS crikora_crawl_queue_identity_uidx
  ON public.crikora_crawl_queue (run_id, identity_key)
  WHERE identity_key IS NOT NULL;
