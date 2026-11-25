-- Durable per-user API quotas shared by every Vercel function instance.

BEGIN;

CREATE TABLE public.api_rate_limits (
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  scope         text NOT NULL CHECK (length(scope) BETWEEN 1 AND 50),
  window_start  timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.api_rate_limits FROM anon, authenticated;

COMMIT;
