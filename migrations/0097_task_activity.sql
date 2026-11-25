-- Durable task history, independent of the live task so deletes remain visible.
-- Apply before deploying cookie-web-tasks, then the web client.
BEGIN;

ALTER TABLE public.task_items ADD COLUMN last_occurrence_completed_at timestamptz;

CREATE TABLE public.task_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  task_title text NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'edited', 'completed', 'reopened', 'deleted')),
  changes jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX task_activity_owner_time_idx ON public.task_activity (user_id, occurred_at DESC, id DESC);
CREATE INDEX task_activity_task_time_idx ON public.task_activity (user_id, task_id, occurred_at DESC, id DESC);
CREATE INDEX task_activity_completion_idx ON public.task_activity (user_id, occurred_at DESC, id DESC)
  WHERE action = 'completed';
ALTER TABLE public.task_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.task_activity FROM anon, authenticated;

CREATE TABLE public.task_completion_goals (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  daily integer NOT NULL DEFAULT 0 CHECK (daily BETWEEN 0 AND 10000),
  weekly integer NOT NULL DEFAULT 0 CHECK (weekly BETWEEN 0 AND 10000)
);
ALTER TABLE public.task_completion_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.task_completion_goals FROM anon, authenticated;

-- Recover only known facts. No historical edits, reopenings, or deletes exist.
INSERT INTO public.task_activity (user_id, task_id, task_title, action, occurred_at)
  SELECT user_id, id, content, 'created', created_at FROM public.task_items WHERE kind = 'task';
INSERT INTO public.task_activity (user_id, task_id, task_title, action, occurred_at)
  SELECT user_id, id, content, 'completed', completed_at FROM public.task_items
  WHERE kind = 'task' AND completed_at IS NOT NULL;

CREATE FUNCTION public.record_task_activity() RETURNS trigger
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
        'due_time', 'time_zone', 'labels', 'priority', 'recurrence', 'position', 'today_position')
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
CREATE TRIGGER task_items_record_activity AFTER INSERT OR UPDATE OR DELETE ON public.task_items
  FOR EACH ROW EXECUTE FUNCTION public.record_task_activity();

COMMIT;
