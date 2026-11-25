-- 0032_scheduled_sends.sql
-- "Send Later": a composed message can be queued to go out at a future
-- scheduled_for instead of immediately. Unlike inbound snooze (0012), where
-- a due message just becomes visible again at query time, an outbound send
-- requires actively calling the mail provider — so a worker cron polls
-- POST /api/send?resource=flush for due rows here rather than the client
-- ever comparing scheduled_for itself.

BEGIN;

CREATE TABLE public.scheduled_sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  to_addresses        text NOT NULL,
  subject             text NOT NULL,
  body_text           text NOT NULL,
  body_html           text,
  reply_to_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  scheduled_for       timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts            smallint NOT NULL DEFAULT 0,
  last_error          text,
  sent_message_id     uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);

-- The flush job's only lookup: due, still-pending rows, oldest first.
CREATE INDEX scheduled_sends_due_idx
  ON public.scheduled_sends (scheduled_for)
  WHERE status = 'pending';

-- The user's own "Scheduled" list.
CREATE INDEX scheduled_sends_user_idx
  ON public.scheduled_sends (user_id, scheduled_for)
  WHERE status = 'pending';

ALTER TABLE public.scheduled_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.scheduled_sends FROM anon, authenticated;

COMMIT;
