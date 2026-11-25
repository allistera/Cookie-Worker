-- 0041_calendar_events_recurring_index.sql
-- fetchNormalizedEvents (api/calendar-events.js) always includes recurring
-- masters regardless of the requested date range, since a series row's
-- event_date is only its start and expandEvents clips occurrences to range
-- downstream. calendar_events_user_date_idx (0022) doesn't help that branch
-- because recurrence_rule isn't part of it. This partial index targets it
-- directly.

BEGIN;

CREATE INDEX calendar_events_user_recurring_idx
  ON public.calendar_events (user_id)
  WHERE recurrence_rule IS NOT NULL;

COMMIT;
