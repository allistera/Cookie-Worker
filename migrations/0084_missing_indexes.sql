-- Indexes for lookups and FK cascades that had no supporting index.
--
-- DEPLOY NOTE: messages and attachments are the hot tables here. At the
-- current size (a few thousand rows) the plain CREATE INDEX below finishes in
-- well under a second, inside the runner's lock and statement timeouts. If
-- either table has grown large, build those two indexes by hand outside a
-- transaction first (see the CREATE INDEX CONCURRENTLY note in migrate.sh);
-- the IF NOT EXISTS statements below are then no-ops for them:
--
--   psql "$DATABASE_URL" -c "SET lock_timeout = '5s'; CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_user_from_idx ON public.messages (user_id, lower(btrim(from_address)));"
--   psql "$DATABASE_URL" -c "SET lock_timeout = '5s'; CREATE INDEX CONCURRENTLY IF NOT EXISTS attachments_blob_url_idx ON public.attachments (blob_url) WHERE blob_url IS NOT NULL;"
--
-- If either is left INVALID (\d shows it), DROP INDEX CONCURRENTLY it and
-- retry.
BEGIN;

-- Orphaned-upload sweeps (api/_lib/outboundUploads.js and Cookie-Worker's
-- cookie-web-send) probe attachments by blob_url in a NOT EXISTS. blob_url
-- has been nullable since 0003 (inbound attachments without a stored blob),
-- and those rows never match the probe, so the index skips them.
CREATE INDEX IF NOT EXISTS attachments_blob_url_idx
  ON public.attachments (blob_url) WHERE blob_url IS NOT NULL;

-- ON DELETE CASCADE from attachments; the inbound unique key leads with
-- draft_id, so it cannot serve this lookup.
CREATE INDEX IF NOT EXISTS draft_attachments_attachment_idx
  ON public.draft_attachments (attachment_id);

-- ON DELETE CASCADE from a parent project to its subprojects.
CREATE INDEX IF NOT EXISTS task_projects_parent_idx
  ON public.task_projects (parent_id);

-- Per-user deletes (sender blocking) and the users ON DELETE CASCADE.
CREATE INDEX IF NOT EXISTS browser_notification_events_user_idx
  ON public.browser_notification_events (user_id);
CREATE INDEX IF NOT EXISTS ntfy_notification_events_user_idx
  ON public.ntfy_notification_events (user_id);

-- Sender screening/blocking (cookie-web-emails senders.js) matches a sender
-- across all of a user's mail, deleted or not, so the NOT is_deleted partial
-- messages_contact_from_idx (0076) cannot serve it.
CREATE INDEX IF NOT EXISTS messages_user_from_idx
  ON public.messages (user_id, lower(btrim(from_address)));

COMMIT;
