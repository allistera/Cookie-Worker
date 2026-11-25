-- Apply before deploying cookie-web-tasks, then the web client.
BEGIN;

ALTER TABLE public.task_items ADD COLUMN duration_minutes integer
  CHECK (duration_minutes BETWEEN 1 AND 1440);
ALTER TABLE public.task_items ADD CONSTRAINT task_items_duration_task_only
  CHECK (duration_minutes IS NULL OR kind = 'task');

CREATE OR REPLACE FUNCTION public.record_task_activity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  item public.task_items;
  diff jsonb;
  event_time timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN item := OLD; ELSE item := NEW; END IF;
  -- Account deletion must cascade history, not recreate it during task cascades.
  IF item.kind <> 'task' OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = item.user_id) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.task_activity (user_id, task_id, task_title, action, occurred_at)
      VALUES (item.user_id, item.id, item.content, 'created', item.created_at);
    IF item.completed_at IS NOT NULL THEN
      INSERT INTO public.task_activity (user_id, task_id, task_title, action, occurred_at)
        VALUES (item.user_id, item.id, item.content, 'completed', item.completed_at);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.task_activity (user_id, task_id, task_title, action, occurred_at)
      VALUES (item.user_id, item.id, item.content, 'deleted', event_time);
  ELSE
    SELECT coalesce(jsonb_object_agg(n.key, jsonb_build_object('before', o.value, 'after', n.value)), '{}')
      INTO diff FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
      WHERE n.key IN ('content', 'description', 'project_id', 'parent_id', 'due_date',
        'due_time', 'time_zone', 'duration_minutes', 'labels', 'priority', 'recurrence', 'position', 'today_position')
        AND n.value IS DISTINCT FROM o.value;
    IF diff <> '{}'::jsonb THEN
      INSERT INTO public.task_activity (user_id, task_id, task_title, action, changes, occurred_at)
        VALUES (item.user_id, item.id, item.content, 'edited', diff, event_time);
    END IF;
    IF (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL)
       OR (NEW.last_occurrence_completed_at IS NOT NULL AND
           NEW.last_occurrence_completed_at IS DISTINCT FROM OLD.last_occurrence_completed_at) THEN
      INSERT INTO public.task_activity (user_id, task_id, task_title, action, occurred_at)
        VALUES (item.user_id, item.id, item.content, 'completed',
          CASE WHEN NEW.last_occurrence_completed_at IS NOT NULL AND
            NEW.last_occurrence_completed_at IS DISTINCT FROM OLD.last_occurrence_completed_at
          THEN NEW.last_occurrence_completed_at ELSE NEW.completed_at END);
    ELSIF OLD.completed_at IS NOT NULL AND NEW.completed_at IS NULL THEN
      INSERT INTO public.task_activity (user_id, task_id, task_title, action, occurred_at)
        VALUES (item.user_id, item.id, item.content, 'reopened', event_time);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
