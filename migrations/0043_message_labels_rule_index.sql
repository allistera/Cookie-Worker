-- 0043_message_labels_rule_index.sql
-- message_labels.rule_id (0029) has no index. Deleting a label rule sets it
-- SET NULL on every referencing row; message_labels is the largest,
-- continuously-growing table in the schema (one row per message x label,
-- auto-populated by AI enrichment and rule matching), so a rule delete was
-- forcing a sequential scan of it.

BEGIN;

CREATE INDEX message_labels_rule_idx
  ON message_labels (rule_id)
  WHERE rule_id IS NOT NULL;

COMMIT;
