-- When a top-level task was last successfully pushed to Meilisearch. NULL
-- means never indexed. Only top-level rows are ever stamped: a sub-task is
-- not its own search document — its title rides along on the parent's (see
-- Cookie-Worker's shared/meili/tasks.js).
--
-- No partial drift index, unlike 0055's documents/messages indexes: the
-- sweep's predicate includes a correlated EXISTS over child rows (a sub-task
-- edit whose sync failed must drift the parent), which an index predicate
-- cannot express — and task_items is a small personal table where the weekly
-- scan is nothing.

BEGIN;

ALTER TABLE public.task_items ADD COLUMN search_indexed_at timestamptz;

COMMIT;
