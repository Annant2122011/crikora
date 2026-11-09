CREATE TABLE IF NOT EXISTS public.crikora_crawl_runs (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued','running','completed','paused')),
  seeded_url_count integer NOT NULL DEFAULT 0 CHECK (seeded_url_count >= 0),
  discovered_url_count integer NOT NULL DEFAULT 0 CHECK (discovered_url_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS crikora_crawl_runs_status_created_idx
  ON public.crikora_crawl_runs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.crikora_crawl_queue (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.crikora_crawl_runs(id) ON DELETE CASCADE,
  canonical_url text NOT NULL,
  page_kind text NOT NULL,
  discovered_from text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed','skipped')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  http_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (run_id, canonical_url)
);

CREATE INDEX IF NOT EXISTS crikora_crawl_queue_due_idx
  ON public.crikora_crawl_queue (run_id, status, next_attempt_at, lease_until);

CREATE INDEX IF NOT EXISTS crikora_crawl_queue_lease_idx
  ON public.crikora_crawl_queue (lease_until)
  WHERE status = 'processing';

CREATE UNIQUE INDEX IF NOT EXISTS crikora_crawl_runs_one_active_idx
  ON public.crikora_crawl_runs ((true))
  WHERE status IN ('queued','running');
