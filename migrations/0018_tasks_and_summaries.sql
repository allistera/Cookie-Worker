-- Daily gathering for the data-enricher Worker: Todoist tasks due today land
-- in tasks, and AI analyses of important task-bearing emails land in
-- summaries. Both follow the 0013 hardening: RLS enabled, app roles revoked,
-- access only through backend connections.

BEGIN;

CREATE TABLE public.tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('todoist', 'email')),
  external_id  text NOT NULL,
  content      text NOT NULL,
  description  text,
  due_date     date,
  -- Todoist priority: 1 (p4, default) through 4 (p1, urgent).
  priority     smallint CHECK (priority IS NULL OR priority BETWEEN 1 AND 4),
  url          text,
  message_id   uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  raw          jsonb NOT NULL DEFAULT '{}'::jsonb,
  gathered_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, external_id)
);

CREATE INDEX tasks_user_due_idx
  ON public.tasks (user_id, due_date);

CREATE TABLE public.summaries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES public.messages(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'email_tasks',
  summary     text NOT NULL,
  model       text,
  raw         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One summary per message per kind; digest-style summaries carry no message.
CREATE UNIQUE INDEX summaries_user_message_kind_idx
  ON public.summaries (user_id, message_id, kind)
  WHERE message_id IS NOT NULL;

CREATE INDEX summaries_user_created_idx
  ON public.summaries (user_id, created_at);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.summaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.tasks FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.summaries FROM anon, authenticated;

COMMIT;
