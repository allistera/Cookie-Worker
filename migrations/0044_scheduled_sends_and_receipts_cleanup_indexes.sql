-- 0044_scheduled_sends_and_receipts_cleanup_indexes.sql
-- listScheduledSends (api/send.js) reads status IN ('pending', 'failed'), but
-- both existing scheduled_sends partial indexes are WHERE status = 'pending'
-- — the failed branch of the user's own "Scheduled" list got no index
-- support. This mirrors the existing pending index so Postgres can bitmap-OR
-- the two.
--
-- message_read_receipts.expires_at (0028) is checked on read but nothing
-- ever deletes expired rows; the flush job (POST /api/send?resource=flush,
-- the only periodic cron trigger this app has) is being extended to sweep
-- both tables, so this index supports that sweep.

BEGIN;

CREATE INDEX scheduled_sends_user_failed_idx
  ON public.scheduled_sends (user_id, scheduled_for)
  WHERE status = 'failed';

CREATE INDEX message_read_receipts_expires_idx
  ON public.message_read_receipts (expires_at);

COMMIT;
