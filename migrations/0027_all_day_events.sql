-- All-day events (e.g. holidays, OOO, imported from a date-only ICS VEVENT).
-- These render in a compact banner above the hourly grid rather than being
-- positioned by start_time/duration_minutes, which is what previously made
-- an all-day sync event stretch across the entire visible timeline. Manual
-- event creation always leaves this false; only calendar sync sets it true.

BEGIN;

ALTER TABLE public.calendar_events
  ADD COLUMN all_day boolean NOT NULL DEFAULT false;

COMMIT;
