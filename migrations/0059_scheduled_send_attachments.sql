-- 0059_scheduled_send_attachments.sql
-- Carries owned inbound attachments through Send Later without exposing
-- private Blob URLs to the browser. The send API resolves ownership before
-- inserting these references; the cron reads the private bytes at delivery.

BEGIN;

CREATE TABLE public.scheduled_send_attachments (
  scheduled_send_id uuid NOT NULL
    REFERENCES public.scheduled_sends(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL
    REFERENCES public.attachments(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  PRIMARY KEY (scheduled_send_id, attachment_id)
);

CREATE INDEX scheduled_send_attachments_attachment_idx
  ON public.scheduled_send_attachments (attachment_id);

ALTER TABLE public.scheduled_send_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.scheduled_send_attachments FROM anon, authenticated;

COMMIT;
