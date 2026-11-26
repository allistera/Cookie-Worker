-- Completions written back to Todoist. Until now the Todoist sync (0093) was
-- one-way: ticking a mirrored task in Cookie was undone by the next run,
-- because Todoist still listed the task as open.
--
-- A mirrored task whose completion changed in Cookie now carries what
-- Todoist has yet to be told: 'close' (it was completed here, or a repeating
-- task's occurrence was) or 'reopen' (it was marked not done again).
-- cookie-web-tasks (src/todoistPush.js) sends it straight after the change
-- and clears the column; whatever is still set is sent by the next sync
-- before it reads Todoist, and a run leaves such a row's completion and due
-- date as Cookie has them. Null on every row Todoist is up to date on, which
-- is nearly all of them, hence the partial index.

BEGIN;

ALTER TABLE public.task_items
  ADD COLUMN todoist_pending text
    CONSTRAINT task_items_todoist_pending_check
    CHECK (todoist_pending IS NULL OR todoist_pending IN ('close', 'reopen'));

CREATE INDEX task_items_todoist_pending_idx
  ON public.task_items (user_id, updated_at)
  WHERE todoist_pending IS NOT NULL;

COMMIT;
