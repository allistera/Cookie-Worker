-- Let each user choose the ntfy server and topic their new-mail alerts go
-- to, with an optional access token for reserved topics or servers that
-- require authentication. Rows written before this carried only a generated
-- topic on the default server, so that server is backfilled here and stays
-- the default for a Worker deployed ahead of its Settings form. The token is
-- stored as AES-256-GCM ciphertext under the notifications Worker's
-- NTFY_TOKEN_ENCRYPTION_KEY; the browser only ever sees token_hint.
--
-- Topics were unique across all servers; now two users may use the same
-- topic on different servers, but never on the same one, or each would
-- receive the other's mail.
BEGIN;

ALTER TABLE public.ntfy_subscriptions
  ADD COLUMN server_url text NOT NULL DEFAULT 'https://ntfy.allisterantosik.com',
  ADD COLUMN access_token_encrypted text,
  ADD COLUMN token_hint text NOT NULL DEFAULT '' CHECK (length(token_hint) <= 8);

ALTER TABLE public.ntfy_subscriptions
  DROP CONSTRAINT ntfy_subscriptions_topic_key;

CREATE UNIQUE INDEX ntfy_subscriptions_server_topic_key
  ON public.ntfy_subscriptions (server_url, topic);

COMMIT;
