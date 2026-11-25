-- The Todoist completion cursor, separate from the last-success stamp.
-- cookie-web-tasks (src/todoistSync.js) reads Todoist's completed tasks
-- from an hour before the last run that read tasks; last_synced_at could not
-- carry that any more once a projects-only run (sync_tasks off, 0094) also
-- counts as a successful run, or completions made while tasks were paused
-- would fall out of the window and their mirrors be deleted when tasks
-- resumed. last_synced_at stays the last successful run of any kind, for
-- Settings. Existing connections start with the cursor at their last run.

BEGIN;

ALTER TABLE public.todoist_connections
  ADD COLUMN tasks_synced_at timestamptz;

UPDATE public.todoist_connections SET tasks_synced_at = last_synced_at;

COMMIT;
