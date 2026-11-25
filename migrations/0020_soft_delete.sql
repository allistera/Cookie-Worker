-- 0020_soft_delete.sql
-- Adds a soft-delete flag to messages so users can trash emails without
-- permanent removal. Deleted messages are excluded from all list queries.

BEGIN;

ALTER TABLE messages ADD COLUMN is_deleted boolean NOT NULL DEFAULT false;

-- Index for excluding deleted rows from list queries efficiently.
CREATE INDEX messages_deleted_idx ON messages (user_id) WHERE is_deleted;

COMMIT;
