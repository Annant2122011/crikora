-- User-configurable refresh cadence for Crikora's authorized source collector.
-- Cache entities remain on their existing ten-minute TTL; operational settings do not expire.
CREATE TABLE IF NOT EXISTS public.crikora_crawler_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  refresh_interval_seconds integer NOT NULL DEFAULT 10
    CHECK (refresh_interval_seconds IN (10, 15, 20, 30)),
  enabled boolean NOT NULL DEFAULT true,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  lease_until timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.crikora_crawler_settings (id, refresh_interval_seconds, enabled)
VALUES (1, 10, true)
ON CONFLICT (id) DO NOTHING;
