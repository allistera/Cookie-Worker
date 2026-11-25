-- 0064_task_items_kind.sql
-- Dividers in the Tasks list: a horizontal rule a person drops between rows
-- to group them, with nothing to say. A divider is a task_items row of kind
-- 'divider' rather than a table of its own, so it takes its place in the
-- same order (position, 0062), drags and moves with the same requests, and
-- goes with its project when that is deleted. Its content is ''; it never
-- carries a date, a parent or sub-tasks, and it is never indexed for search.

BEGIN;

ALTER TABLE public.task_items
  ADD COLUMN kind text NOT NULL DEFAULT 'task'
    CONSTRAINT task_items_kind_check CHECK (kind IN ('task', 'divider'));

COMMIT;
