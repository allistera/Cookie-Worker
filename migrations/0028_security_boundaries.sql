-- Bound externally triggerable receipt writes and outbound-email use. Both
-- tables remain server-only; the browser reaches them only through ownership-
-- checked Vercel Functions.

BEGIN;

ALTER TABLE public.message_read_receipts
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days');

CREATE TABLE public.outbound_email_quotas (
  user_id       uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  window_start  timestamptz NOT NULL,
  send_count    smallint NOT NULL CHECK (send_count BETWEEN 1 AND 10),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.outbound_email_quotas ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.outbound_email_quotas FROM anon, authenticated;

COMMIT;
