-- Two switches on the Todoist connection (0093): whether a run mirrors the
-- account's projects, and whether it mirrors its sections and tasks. Both
-- default on, which is what every existing connection did before. With
-- projects off, a task whose Todoist project Cookie does not hold lands in
-- the Inbox instead of being skipped (cookie-web-tasks, src/todoistSync.js).

BEGIN;

ALTER TABLE public.todoist_connections
  ADD COLUMN sync_projects boolean NOT NULL DEFAULT true,
  ADD COLUMN sync_tasks    boolean NOT NULL DEFAULT true;

COMMIT;
