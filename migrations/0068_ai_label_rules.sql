-- AI rules: a label rule can now be defined by a plain-language prompt
-- instead of subject/body/from/to conditions. A kind = 'ai' rule carries a
-- prompt and no condition rows; Cookie-Worker's mail-app-ingest hands the
-- prompts to the same classification call that auto-tags by label
-- description, so AI rules run on the best-effort enrichment path
-- (confidence threshold, retry sweep) rather than inside the storage
-- transaction like kind = 'conditions' rules. message_labels.rule_id already
-- records provenance for either kind; AI-rule labels keep source = 'ai' so a
-- re-classification replaces them along with the other AI labels.

BEGIN;

ALTER TABLE label_rules
  ADD COLUMN kind text NOT NULL DEFAULT 'conditions' CHECK (kind IN ('conditions', 'ai')),
  ADD COLUMN prompt text,
  ADD CONSTRAINT label_rules_kind_prompt_ck CHECK (
    (kind = 'ai' AND prompt IS NOT NULL) OR
    (kind = 'conditions' AND prompt IS NULL)
  );

COMMIT;
