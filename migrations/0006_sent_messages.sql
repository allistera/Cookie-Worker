-- 0006_sent_messages.sql
-- Outbound mail sent via /api/send is stored alongside received mail.
-- is_sent distinguishes it: the inbox list excludes sent rows, search
-- includes them.

BEGIN;

ALTER TABLE messages
  ADD COLUMN is_sent boolean NOT NULL DEFAULT false;

COMMIT;
