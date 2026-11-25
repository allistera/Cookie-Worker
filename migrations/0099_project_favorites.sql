-- Apply before deploying cookie-web-tasks, then the web client.
ALTER TABLE public.task_projects
  ADD COLUMN is_favorite boolean NOT NULL DEFAULT false;
