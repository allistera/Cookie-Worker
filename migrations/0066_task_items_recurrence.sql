BEGIN;

ALTER TABLE task_items ADD COLUMN recurrence text;
ALTER TABLE task_items ADD CONSTRAINT task_items_recurrence_check
  CHECK (recurrence IS NULL OR (kind = 'task' AND due_date IS NOT NULL AND length(recurrence) BETWEEN 1 AND 100));

COMMIT;
