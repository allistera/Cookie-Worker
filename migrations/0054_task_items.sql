-- Cookie-owned tasks: the ones a person writes, as opposed to the gathered
-- rows in `tasks` that the overnight enricher rewrites and deletes on
-- completion. The two never share a row.
--
-- project_id IS NULL is the Inbox — the same rule the sidebar already
-- encodes, so there is no row to seed, rename or delete.
--
-- parent_id ships now even though sub-tasks are a later phase: the column
-- costs nothing here and avoids a second migration against a populated table.

BEGIN;

CREATE TABLE public.task_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  project_id   uuid REFERENCES public.task_projects(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES public.task_items(id) ON DELETE CASCADE,
  content      text NOT NULL,
  description  text,
  due_date     date,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_items_user_project_idx ON public.task_items (user_id, project_id);

ALTER TABLE public.task_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.task_items FROM anon, authenticated;

-- The project view's "Add a description" line.
ALTER TABLE public.task_projects ADD COLUMN description text;

COMMIT;
