BEGIN;

ALTER TABLE task_items
  ADD COLUMN due_time time,
  ADD COLUMN time_zone text,
  ADD COLUMN labels text[] NOT NULL DEFAULT '{}';

ALTER TABLE task_items ADD CONSTRAINT task_items_time_check CHECK (
  (due_time IS NULL AND time_zone IS NULL)
  OR (kind = 'task' AND due_date IS NOT NULL AND due_time IS NOT NULL
      AND time_zone IS NOT NULL AND length(time_zone) BETWEEN 1 AND 100)
);
ALTER TABLE task_items ADD CONSTRAINT task_items_labels_check
  CHECK (cardinality(labels) <= 20 AND (kind = 'task' OR cardinality(labels) = 0));

COMMIT;
