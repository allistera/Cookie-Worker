-- 0060_outbound_attachments.sql
-- Composer uploads: files the user picks in the composer or reply box, which
-- have no message to hang off yet. Inbound attachments are owned through
-- their message (attachments.message_id is NOT NULL); an upload is owned
-- directly by the user until the send that consumes it.
--
-- Bytes go straight from the browser to Vercel Blob under a short-lived
-- client token, so only the blob_url recorded here — never a URL handed back
-- on read — lets the send path stream the file at delivery.

BEGIN;

CREATE TABLE public.outbound_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  filename text,
  content_type text,
  size_bytes bigint,
  blob_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supports both the per-user pending list and the age-ordered orphan sweep.
CREATE INDEX outbound_attachments_user_created_idx
  ON public.outbound_attachments (user_id, created_at);

ALTER TABLE public.outbound_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.outbound_attachments FROM anon, authenticated;

-- A scheduled send can now carry either kind: a forwarded inbound attachment
-- or a composer upload. 0059's table is still empty, so its key can be
-- restructured in place rather than through a copy.
ALTER TABLE public.scheduled_send_attachments
  ADD COLUMN outbound_attachment_id uuid
    REFERENCES public.outbound_attachments(id) ON DELETE CASCADE;

-- The primary key has to go first: a column still in it cannot drop NOT NULL.
ALTER TABLE public.scheduled_send_attachments
  DROP CONSTRAINT scheduled_send_attachments_pkey;

ALTER TABLE public.scheduled_send_attachments
  ALTER COLUMN attachment_id DROP NOT NULL;

ALTER TABLE public.scheduled_send_attachments
  ADD CONSTRAINT scheduled_send_attachments_one_source
    CHECK (num_nonnulls(attachment_id, outbound_attachment_id) = 1);

-- The dropped primary key deduplicated (send, attachment). Keep that
-- guarantee per source, and keep an unconditional lookup path by send —
-- neither partial index alone covers a mixed row set.
CREATE UNIQUE INDEX scheduled_send_attachments_inbound_key
  ON public.scheduled_send_attachments (scheduled_send_id, attachment_id)
  WHERE attachment_id IS NOT NULL;

CREATE UNIQUE INDEX scheduled_send_attachments_outbound_key
  ON public.scheduled_send_attachments (scheduled_send_id, outbound_attachment_id)
  WHERE outbound_attachment_id IS NOT NULL;

CREATE INDEX scheduled_send_attachments_send_idx
  ON public.scheduled_send_attachments (scheduled_send_id);

CREATE INDEX scheduled_send_attachments_outbound_idx
  ON public.scheduled_send_attachments (outbound_attachment_id);

COMMIT;
