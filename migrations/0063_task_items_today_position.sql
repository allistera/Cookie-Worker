-- 0063_task_items_today_position.sql
-- Today has an order of its own. It lists tasks from every project, so
-- re-arranging a day there cannot be expressed through `position` (0062)
-- without moving a task among its siblings in its own project. today_position
-- is read only by Today's ORDER BY (after due_date) and written only when a
-- day is re-arranged there; NULL — never arranged — sorts after the rows that
-- were.

BEGIN;

ALTER TABLE public.task_items ADD COLUMN today_position double precision;

COMMIT;
