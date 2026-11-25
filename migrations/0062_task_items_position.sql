-- 0062_task_items_position.sql
-- Drag-and-drop ordering for the Tasks list. Rows were ordered by created_at;
-- position takes over, seeded from created_at so nothing visibly moves on
-- upgrade. It is fractional so a drop is one UPDATE (the midpoint of its new
-- neighbours) rather than a renumbering of the list. New rows default to
-- "now", which keeps them at the bottom like they always were.

BEGIN;

ALTER TABLE public.task_items ADD COLUMN position double precision;

UPDATE public.task_items SET position = extract(epoch from created_at);

ALTER TABLE public.task_items
  ALTER COLUMN position SET NOT NULL,
  ALTER COLUMN position SET DEFAULT extract(epoch from clock_timestamp());

COMMIT;
