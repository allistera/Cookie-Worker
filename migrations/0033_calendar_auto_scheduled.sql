-- 0033_calendar_auto_scheduled.sql
-- Plumbing ahead of a feature: the Calendar view's "Auto-scheduled" insight
-- card previously showed a hardcoded "2 events" with no backing data. This
-- adds a real column so the card can report a genuine count instead of
-- fabricated copy. Nothing sets is_auto_scheduled to true yet — there is no
-- auto-scheduling feature in the app today — so the count will read 0 until
-- a future feature actually books events on the user's behalf.

BEGIN;

ALTER TABLE public.calendar_events
  ADD COLUMN is_auto_scheduled boolean NOT NULL DEFAULT false;

COMMIT;
