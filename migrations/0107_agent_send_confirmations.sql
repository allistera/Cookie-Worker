-- One-time permits for agent sends. The mailbox owner mints a token in
-- Cookie; the send worker stores only its hash. The same permit can be
-- retried for one request id until it expires.

BEGIN;

CREATE TABLE public.mcp_send_confirmations (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  request_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX mcp_send_confirmations_user_expires_idx
  ON public.mcp_send_confirmations (user_id, expires_at);

ALTER TABLE public.mcp_send_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.mcp_send_confirmations FROM PUBLIC, anon, authenticated;

COMMIT;
