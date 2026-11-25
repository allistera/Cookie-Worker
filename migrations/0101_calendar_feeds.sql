-- One revocable, read-only subscription per native calendar. Only the SHA-256
-- digest is stored; the bearer token is returned once when generating a link.
BEGIN;

CREATE TABLE public.calendar_feeds (
  calendar_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, calendar_id)
    REFERENCES public.calendars (user_id, id) ON DELETE CASCADE
);

CREATE INDEX calendar_feeds_user_idx ON public.calendar_feeds (user_id);
ALTER TABLE public.calendar_feeds ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.calendar_feeds FROM anon, authenticated;

COMMIT;
