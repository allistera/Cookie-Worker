-- 0052_follow_up_reminders.sql
-- Optional "remind me if no reply" timestamps for sent messages. Send Later
-- rows carry the timestamp until delivery creates the corresponding sent row.

BEGIN;

ALTER TABLE public.messages
  ADD COLUMN follow_up_at timestamptz;

CREATE INDEX messages_follow_up_due_idx
  ON public.messages (user_id, follow_up_at, sent_at DESC)
  WHERE is_sent AND follow_up_at IS NOT NULL AND NOT is_deleted;

ALTER TABLE public.scheduled_sends
  ADD COLUMN follow_up_at timestamptz,
  ADD CONSTRAINT scheduled_sends_follow_up_after_send
    CHECK (follow_up_at IS NULL OR follow_up_at > scheduled_for);

COMMIT;
