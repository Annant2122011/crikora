-- Singleton lease prevents duplicate durable Vercel refresh workflows.
CREATE TABLE IF NOT EXISTS public.crikora_worker_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lease_until timestamptz,
  lease_token text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.crikora_worker_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
