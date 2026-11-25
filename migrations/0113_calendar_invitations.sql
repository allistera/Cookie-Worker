-- Calendar invitations received by email (iTIP REQUEST and CANCEL), and the
-- link from a calendar entry to the invitation it was made from.
--
-- An invitation is one event as its organiser describes it. Its identity is
-- the iCalendar UID plus, for a single occurrence of a repeating event, that
-- occurrence's RECURRENCE-ID ('' otherwise). The unique constraint on that
-- identity is what lets a revised or cancelled invitation update the same row
-- instead of making a second one. sequence and dtstamp order the revisions.
--
-- response is the person's answer to the current revision; reply_revision
-- counts the answers given, and names each reply mail in the delivery ledger
-- (cookie-web-send), so a retried request cannot send the same reply twice.
--
-- calendar_events.invitation_id ties an entry to its invitation. One entry per
-- invitation per day (an all-day invitation covers several days), so the
-- calendar cannot hold the same invitation twice. The foreign key clears the
-- link, rather than deleting the entry, if an invitation row ever goes.
--
-- Cookie-Worker reads and writes these through its own database role; no API
-- role gets access.
BEGIN;

CREATE TABLE public.calendar_invitations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  uid               text NOT NULL CHECK (length(uid) BETWEEN 1 AND 500),
  recurrence_id     text NOT NULL DEFAULT ''
                      CHECK (recurrence_id ~ '^(\d{8}(T\d{6}Z)?)?$'),
  sequence          integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  dtstamp           timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  organizer_address text NOT NULL CHECK (length(organizer_address) <= 320),
  organizer_name    text CHECK (organizer_name IS NULL OR length(organizer_name) <= 200),
  attendee_address  text CHECK (attendee_address IS NULL OR length(attendee_address) <= 320),
  attendee_name     text CHECK (attendee_name IS NULL OR length(attendee_name) <= 200),
  title             text NOT NULL CHECK (length(title) <= 200),
  description       text CHECK (description IS NULL OR length(description) <= 2000),
  location          text CHECK (location IS NULL OR length(location) <= 200),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  all_day           boolean NOT NULL DEFAULT false,
  recurrence_rule   text CHECK (recurrence_rule IS NULL OR length(recurrence_rule) <= 500),
  time_zone         text CHECK (time_zone IS NULL OR length(time_zone) <= 100),
  response          text CHECK (response IS NULL OR response IN ('accepted', 'tentative', 'declined')),
  responded_at      timestamptz,
  reply_revision    integer NOT NULL DEFAULT 0 CHECK (reply_revision >= 0),
  event_time_zone   text CHECK (event_time_zone IS NULL OR length(event_time_zone) <= 100),
  message_id        uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  UNIQUE (user_id, uid, recurrence_id)
);

CREATE INDEX calendar_invitations_message_idx
  ON public.calendar_invitations (message_id)
  WHERE message_id IS NOT NULL;

ALTER TABLE public.calendar_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.calendar_invitations FROM PUBLIC, anon, authenticated;

ALTER TABLE public.calendar_events
  ADD COLUMN invitation_id uuid REFERENCES public.calendar_invitations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX calendar_events_invitation_day_idx
  ON public.calendar_events (invitation_id, event_date)
  WHERE invitation_id IS NOT NULL;

COMMIT;
