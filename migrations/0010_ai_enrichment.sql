-- AI enrichment for inbound mail: per-label auto-apply preferences, durable
-- classification state, and provenance for model-applied labels.

BEGIN;

ALTER TABLE labels
  ADD COLUMN auto_apply boolean NOT NULL DEFAULT true;

ALTER TABLE message_labels
  ADD COLUMN source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'ai', 'rule')),
  ADD COLUMN confidence real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  ADD COLUMN model text,
  ADD COLUMN prompt_version text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE message_ai (
  message_id      uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'completed', 'failed')),
  spam_verdict    text CHECK (spam_verdict IN ('inbox', 'spam', 'review')),
  spam_score      real CHECK (spam_score IS NULL OR spam_score BETWEEN 0 AND 1),
  spam_reason     text,
  summary         text,
  priority        text CHECK (priority IN ('low', 'normal', 'high')),
  provider        text,
  model           text,
  prompt_version  text,
  error_code      text,
  processed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_ai_spam_idx
  ON message_ai (spam_verdict, message_id)
  WHERE spam_verdict = 'spam';

CREATE INDEX message_ai_recovery_idx
  ON message_ai (status, updated_at)
  WHERE status IN ('pending', 'failed');

COMMIT;
