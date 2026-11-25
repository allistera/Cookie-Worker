-- Opaque tracking tokens record best-effort opens for sent messages. Receipt
-- rows are server-only and deliberately separate from messages so the mail
-- list remains deployable while this migration rolls out.

BEGIN;

CREATE TABLE public.message_read_receipts (
  message_id       uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token            uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  first_opened_at  timestamptz,
  last_opened_at   timestamptz,
  open_count       integer NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_read_receipts_user_idx
  ON public.message_read_receipts (user_id, message_id);

ALTER TABLE public.message_read_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.message_read_receipts FROM anon, authenticated;

COMMIT;
