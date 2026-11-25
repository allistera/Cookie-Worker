-- Fields the mail-app-ingest worker needs to store inbound mail directly in
-- the existing tables. All additive/nullable — existing rows are unaffected.
BEGIN;

ALTER TABLE messages
  ADD COLUMN message_id    text,     -- RFC Message-ID (or deterministic synthetic) for idempotency
  ADD COLUMN headers       jsonb,    -- full parsed headers [{key,value}]
  ADD COLUMN body_html     text,     -- inline HTML, capped at 512 KB; body_html_url stays for future Blob use
  ADD COLUMN raw_size      integer,  -- size of the raw MIME message in bytes
  ADD COLUMN truncated     boolean NOT NULL DEFAULT false,  -- a body exceeded the cap and was cut
  ADD COLUMN envelope_from text,     -- SMTP MAIL FROM (differs from the From header on bounces/lists)
  ADD COLUMN envelope_to   text;     -- SMTP RCPT TO (which catch-all address was hit)

-- Senders retry: the worker inserts with ON CONFLICT DO NOTHING against this.
CREATE UNIQUE INDEX messages_user_message_id_key
  ON messages (user_id, message_id) WHERE message_id IS NOT NULL;

-- v1 stores attachment metadata only (no blobs — R2 in a future iteration).
ALTER TABLE attachments ALTER COLUMN blob_url DROP NOT NULL;

COMMIT;
