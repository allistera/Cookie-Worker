-- Rules could previously only apply a label. Introduce an explicit action so
-- a rule can instead mark matching mail done (is_archived/is_unread), the
-- same terminal state the "Marked done" archive flow sets. label_id becomes
-- optional and the two columns are kept consistent with a CHECK rather than
-- a second nullable action-specific column, since more actions are plausible
-- later.

BEGIN;

ALTER TABLE label_rules
  ALTER COLUMN label_id DROP NOT NULL,
  ADD COLUMN action text NOT NULL DEFAULT 'apply_label'
    CHECK (action IN ('apply_label', 'mark_done')),
  ADD CONSTRAINT label_rules_action_label_ck CHECK (
    (action = 'apply_label' AND label_id IS NOT NULL) OR
    (action = 'mark_done' AND label_id IS NULL)
  );

COMMIT;
