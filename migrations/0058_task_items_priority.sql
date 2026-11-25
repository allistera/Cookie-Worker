-- Task priority, Todoist-style: 1 is the most urgent, 4 is the default and
-- reads as "no priority" in the UI (a plain flag rather than a coloured one).
--
-- NOT NULL with a default rather than nullable: every task has a priority,
-- and "unset" is just the lowest one. That spares every reader a COALESCE
-- and keeps a future ORDER BY priority honest without NULLS LAST juggling.
-- The CHECK keeps the API's 1..4 validation from being the only guard.

BEGIN;

ALTER TABLE public.task_items
  ADD COLUMN priority smallint NOT NULL DEFAULT 4
    CONSTRAINT task_items_priority_range CHECK (priority BETWEEN 1 AND 4);

COMMIT;
