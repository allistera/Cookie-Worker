-- Cookie-owned projects for the Tasks app: a self-nesting tree the Tasks
-- sidebar renders. Shaped after document_folders (migration 0036) so the
-- cascade and RLS posture match a table already proven in production, with
-- title renamed to name and emoji dropped -- a project is its name and
-- its place in the tree, nothing more.
--
-- There is deliberately no "Inbox" row. Inbox is the name the UI gives to
-- tasks belonging to no project, so it needs no record and no seeding.

BEGIN;

CREATE TABLE public.task_projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES public.task_projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_projects_user_idx ON public.task_projects (user_id);

ALTER TABLE public.task_projects ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.task_projects FROM anon, authenticated;

COMMIT;
