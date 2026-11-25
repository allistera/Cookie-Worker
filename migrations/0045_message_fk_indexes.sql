-- 0045_message_fk_indexes.sql
-- Insurance indexes on FK columns referencing messages(id) that have no
-- index of their own today. The app currently only soft-deletes messages
-- (is_deleted), so this is latent rather than an active hot path — but any
-- future hard-delete/purge would trigger an SET NULL/CASCADE that
-- sequentially scans each referencing table without these.

BEGIN;

CREATE INDEX tasks_message_idx
  ON tasks (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX summaries_message_idx
  ON summaries (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX scheduled_sends_reply_to_message_idx
  ON scheduled_sends (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

CREATE INDEX scheduled_sends_sent_message_idx
  ON scheduled_sends (sent_message_id)
  WHERE sent_message_id IS NOT NULL;

COMMIT;
