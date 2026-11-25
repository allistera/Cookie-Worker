-- 0014_messages_user_sent_idx.sql
-- Every folder list filters messages by user and orders by (sent_at, id)
-- DESC for keyset pagination, but no index served that shape; list pages
-- relied on per-user scans. This composite index makes them index-ordered.

BEGIN;

CREATE INDEX messages_user_sent_idx
  ON messages (user_id, sent_at DESC, id DESC);

COMMIT;
