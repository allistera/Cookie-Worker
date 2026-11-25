-- 0061_drafts.sql
-- Server-side composer drafts. Until now the only outbound state that
-- survived a reload was the undo-send holding row (scheduled_sends) and the
-- client-side pendingSend timer; a half-written message lived in the browser
-- tab and died with it.
--
-- Drafts are deliberately not `messages` rows: messages requires from_address,
-- recipients, thread_id and sent_at, carries the search tsvector and thread
-- counters, and is append-only in practice. A draft has none of those, is
-- empty when it is created, and is rewritten every few seconds while someone
-- types.

BEGIN;

CREATE TABLE public.drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  to_addresses text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  body_html text,
  -- A reply draft remembers its target, but deleting the message it answers
  -- must not delete the words already written about it.
  reply_to_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  follow_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The Drafts view lists newest-first per user; the cap check counts per user.
CREATE INDEX drafts_user_updated_idx ON public.drafts (user_id, updated_at DESC);

ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.drafts FROM anon, authenticated;

-- Same two-source shape as scheduled_send_attachments (0059/0060): a draft can
-- carry a forwarded inbound attachment or a composer upload.
CREATE TABLE public.draft_attachments (
  draft_id uuid NOT NULL REFERENCES public.drafts(id) ON DELETE CASCADE,
  attachment_id uuid REFERENCES public.attachments(id) ON DELETE CASCADE,
  outbound_attachment_id uuid
    REFERENCES public.outbound_attachments(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  CONSTRAINT draft_attachments_one_source
    CHECK (num_nonnulls(attachment_id, outbound_attachment_id) = 1)
);

CREATE INDEX draft_attachments_draft_idx
  ON public.draft_attachments (draft_id);

CREATE UNIQUE INDEX draft_attachments_inbound_key
  ON public.draft_attachments (draft_id, attachment_id)
  WHERE attachment_id IS NOT NULL;

-- Also the lookup the orphaned-upload sweep uses to spare a draft's files.
CREATE UNIQUE INDEX draft_attachments_outbound_key
  ON public.draft_attachments (draft_id, outbound_attachment_id)
  WHERE outbound_attachment_id IS NOT NULL;

CREATE INDEX draft_attachments_outbound_idx
  ON public.draft_attachments (outbound_attachment_id);

ALTER TABLE public.draft_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.draft_attachments FROM anon, authenticated;

COMMIT;
