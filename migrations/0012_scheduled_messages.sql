-- 0012_scheduled_messages.sql
-- Future-dated messages are snoozed until scheduled_for; once due they return
-- to the inbox and are surfaced in the Due Today group.

BEGIN;

ALTER TABLE messages
  ADD COLUMN scheduled_for timestamptz;

CREATE INDEX messages_scheduled_idx
  ON messages (user_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL AND NOT is_archived;

COMMIT;
