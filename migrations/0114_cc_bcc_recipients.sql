-- The Cc and Bcc lines of a message that has not gone out yet: a saved draft,
-- and a Send Later row waiting for its time. Each is a comma-separated list of
-- addresses, like to_addresses beside it; '' means the line is not used.
--
-- A sent message keeps all three lines in messages.recipients, which already
-- has them, so nothing changes there.
--
-- Cookie-Worker (cookie-web-drafts, cookie-web-send) reads these columns in a
-- way that tolerates their absence and writes them only for mail that has a
-- copy line, so that release can be deployed before or after this migration.
BEGIN;

ALTER TABLE public.drafts
  ADD COLUMN cc_addresses text NOT NULL DEFAULT '',
  ADD COLUMN bcc_addresses text NOT NULL DEFAULT '';

ALTER TABLE public.scheduled_sends
  ADD COLUMN cc_addresses text NOT NULL DEFAULT '',
  ADD COLUMN bcc_addresses text NOT NULL DEFAULT '';

COMMIT;
