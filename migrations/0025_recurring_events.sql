-- Recurring calendar events. A single calendar_events row is the series
-- master (its event_date/start_time is the first occurrence); recurrence_rule
-- describes how it repeats. Kept intentionally simple (no BYDAY, no custom
-- interval, no per-occurrence exceptions) to match the app's existing
-- calendar scope. The UNTIL date reuses the same plain-text 'YYYY-MM-DD'
-- convention as event_date, for the same reason (see 0022).

BEGIN;

ALTER TABLE public.calendar_events
  ADD COLUMN recurrence_rule text
    CHECK (
      recurrence_rule IS NULL
      OR recurrence_rule ~ '^(DAILY|WEEKLY|MONTHLY|YEARLY)(;UNTIL=\d{4}-\d{2}-\d{2})?$'
    );

COMMIT;
