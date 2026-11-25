-- Google Calendar sign-in for the Calendar view (Cookie-Worker's
-- cookie-web-calendar, src/googleAuth.js + src/googleCalendar.js). One
-- connection per user: the OAuth refresh token (and the short-lived access
-- token it mints) encrypted with AES-256-GCM under the Worker's
-- GOOGLE_TOKEN_ENCRYPTION_KEY secret, the Google account's email for display,
-- and a snapshot of the calendars the person chose to show in Cookie
-- (id, name, colour, access) so listing them needs no Google round trip.
-- Nothing from Google is mirrored into calendar_events: events are read live
-- per window and written straight back to Google.
--
-- needs_reauth is set when Google refuses a refresh with invalid_grant
-- (consent withdrawn, password change); the row stays so Settings can offer
-- "Reconnect" without losing the calendar selection.
--
-- google_calendar_oauth_states holds the single-use `state` of an in-progress
-- sign-in, bound to the user who started it. Google's redirect back to the
-- Worker is a top-level navigation with no bearer token, so this row is what
-- ties the returned code to a Cookie account. Rows expire after ten minutes
-- and are cleared opportunistically on the next sign-in attempt.
--
-- Follows the 0013 hardening: RLS enabled, app roles revoked, access only
-- through backend connections.

BEGIN;

CREATE TABLE public.google_calendar_connections (
  user_id                 uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  google_email            text CHECK (google_email IS NULL OR length(google_email) <= 320),
  refresh_token_encrypted text NOT NULL,
  access_token_encrypted  text,
  access_token_expires_at timestamptz,
  selected_calendars      jsonb NOT NULL DEFAULT '[]'::jsonb
                            CHECK (jsonb_typeof(selected_calendars) = 'array'),
  needs_reauth            boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.google_calendar_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.google_calendar_connections FROM anon, authenticated;

CREATE TABLE public.google_calendar_oauth_states (
  state        text PRIMARY KEY CHECK (length(state) <= 128),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL CHECK (length(redirect_uri) <= 2000),
  return_to    text NOT NULL CHECK (length(return_to) <= 2000),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX google_calendar_oauth_states_expires_idx
  ON public.google_calendar_oauth_states (expires_at);

ALTER TABLE public.google_calendar_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.google_calendar_oauth_states FROM anon, authenticated;

COMMIT;
