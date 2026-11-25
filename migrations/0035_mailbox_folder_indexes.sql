-- 0035_mailbox_folder_indexes.sql
-- Keep the hot folder indexes small and in keyset-pagination order. The
-- broader messages_user_sent_idx remains useful for searches that span every
-- folder, while these partial indexes avoid scanning irrelevant mailbox rows.

BEGIN;

CREATE INDEX messages_inbox_list_idx
  ON messages (user_id, sent_at DESC, id DESC)
  WHERE NOT is_deleted AND NOT is_archived AND NOT is_sent;

CREATE INDEX messages_done_list_idx
  ON messages (user_id, sent_at DESC, id DESC)
  WHERE NOT is_deleted AND is_archived;

CREATE INDEX messages_sent_list_idx
  ON messages (user_id, sent_at DESC, id DESC)
  WHERE NOT is_deleted AND NOT is_archived AND is_sent;

COMMIT;
