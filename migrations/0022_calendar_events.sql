-- Calendar events, created/edited/deleted from the Calendar view. Dates and
-- times are stored as plain text ('YYYY-MM-DD' / 'HH:MM') rather than native
-- date/time columns: the app never does date arithmetic in SQL, and this
-- sidesteps timezone-shift surprises from postgres.js's date deserialization.
-- Follows the 0013 hardening: RLS enabled, app roles revoked, access only
-- through backend connections.

BEGIN;

CREATE TABLE public.calendar_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  location         text,
  event_date       text NOT NULL CHECK (event_date ~ '^\d{4}-\d{2}-\d{2}$'),
  start_time       text NOT NULL CHECK (start_time ~ '^\d{2}:\d{2}$'),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  calendar         text NOT NULL DEFAULT 'personal'
                     CHECK (calendar IN ('work', 'personal', 'focus', 'birthdays', 'holidays')),
  tone             text CHECK (tone IS NULL OR tone IN ('default', 'dark', 'conflict', 'accepted', 'suggested')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX calendar_events_user_date_idx
  ON public.calendar_events (user_id, event_date);

ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.calendar_events FROM anon, authenticated;

COMMIT;
