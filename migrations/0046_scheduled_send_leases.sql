-- 0046_scheduled_send_leases.sql
-- A serverless invocation can stop after claiming a scheduled send. Keep a
-- timestamped lease so a later flush can reclaim it and reuse the same Resend
-- idempotency key instead of leaving it stuck or delivering it twice.

BEGIN;

ALTER TABLE public.scheduled_sends
  ADD COLUMN claimed_at timestamptz;

-- Give rows claimed by an older deployment a fresh lease. This avoids racing
-- an invocation that is still delivering while ensuring crashed claims become
-- recoverable after the lease expires.
UPDATE public.scheduled_sends
SET claimed_at = now()
WHERE status = 'sending';

CREATE INDEX scheduled_sends_claimable_idx
  ON public.scheduled_sends (status, scheduled_for, claimed_at)
  WHERE status IN ('pending', 'sending');

COMMIT;
