-- Contract phase for user-managed calendars. Migration 0023 and the
-- compatible application version are already deployed, so legacy slugs can
-- now be normalized and protected by a database ownership constraint.

BEGIN;

UPDATE public.calendar_events ce
SET calendar = c.id::text
FROM public.calendars c
WHERE c.user_id = ce.user_id
  AND c.name = CASE ce.calendar
    WHEN 'work' THEN 'Work'
    WHEN 'personal' THEN 'Personal'
    WHEN 'focus' THEN 'Focus time'
    WHEN 'birthdays' THEN 'Birthdays'
    WHEN 'holidays' THEN 'Holidays'
  END;

ALTER TABLE public.calendar_events
  ALTER COLUMN calendar DROP DEFAULT,
  ALTER COLUMN calendar TYPE uuid USING calendar::uuid;

ALTER TABLE public.calendar_events
  ADD CONSTRAINT calendar_events_user_calendar_fkey
  FOREIGN KEY (user_id, calendar)
  REFERENCES public.calendars (user_id, id)
  ON DELETE RESTRICT;

CREATE INDEX calendar_events_user_calendar_idx
  ON public.calendar_events (user_id, calendar);

COMMIT;
