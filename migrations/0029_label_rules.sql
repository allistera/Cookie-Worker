-- Deterministic tag rules: user-defined subject/body/from/to conditions that
-- auto-apply a label at inbound storage time. Distinct from AI auto-tagging
-- (message_labels.source = 'ai'); rules are exact string matching evaluated
-- by Cookie-Worker inside the same transaction that stores the message, so
-- they need no async recovery path the way best-effort AI enrichment does.

BEGIN;

CREATE TABLE label_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label_id    uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  name        text,
  match_type  text NOT NULL DEFAULT 'all' CHECK (match_type IN ('all', 'any')),
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX label_rules_user_idx ON label_rules (user_id) WHERE enabled;
CREATE INDEX label_rules_label_idx ON label_rules (label_id);

CREATE TABLE label_rule_conditions (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id   uuid NOT NULL REFERENCES label_rules(id) ON DELETE CASCADE,
  field     text NOT NULL CHECK (field IN ('subject', 'body', 'from', 'to')),
  operator  text NOT NULL
            CHECK (operator IN ('contains', 'equals', 'starts_with', 'ends_with')),
  value     text NOT NULL,
  position  int NOT NULL DEFAULT 0
);

CREATE INDEX label_rule_conditions_rule_idx ON label_rule_conditions (rule_id, position);

-- Provenance: which rule applied a source = 'rule' label, so a future "why was
-- this tagged" view or rule edit/delete can be reasoned about. Distinct from
-- the AI provenance columns (confidence/model/prompt_version), which stay
-- NULL for rule-applied rows.
ALTER TABLE message_labels
  ADD COLUMN rule_id uuid REFERENCES label_rules(id) ON DELETE SET NULL;

ALTER TABLE label_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE label_rule_conditions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE label_rules, label_rule_conditions FROM anon, authenticated;

COMMIT;
