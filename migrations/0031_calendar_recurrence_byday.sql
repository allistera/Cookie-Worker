-- Allows a WEEKLY recurrence to repeat on specific days (e.g. "Monday to
-- Friday") instead of just the series' own start-date weekday, by widening
-- the recurrence_rule format from migration 0025 with an optional
-- BYDAY=MO,TU,... segment (RFC5545-style two-letter weekday codes). Placed
-- between FREQ and UNTIL to keep the format's field order fixed.

BEGIN;

ALTER TABLE public.calendar_events
  DROP CONSTRAINT IF EXISTS calendar_events_recurrence_rule_check;

ALTER TABLE public.calendar_events
  ADD CONSTRAINT calendar_events_recurrence_rule_check
    CHECK (
      recurrence_rule IS NULL
      OR recurrence_rule ~ (
        '^(DAILY|WEEKLY|MONTHLY|YEARLY)'
        || '(;BYDAY=(SU|MO|TU|WE|TH|FR|SA)(,(SU|MO|TU|WE|TH|FR|SA)){0,6})?'
        || '(;UNTIL=\d{4}-\d{2}-\d{2})?$'
      )
    );

COMMIT;
