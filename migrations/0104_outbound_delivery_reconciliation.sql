-- Commit delivery identity before provider I/O; never extend its retry window.
BEGIN;

CREATE TABLE public.outbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),
  request_id text,
  provider_payload jsonb NOT NULL,
  copy_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'accepted', 'complete', 'rejected', 'uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  first_attempt_at timestamptz,
  retry_until timestamptz,
  claimed_at timestamptz,
  claim_token uuid,
  provider_id text,
  accepted_at timestamptz,
  sent_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_key),
  CHECK ((first_attempt_at IS NULL) = (retry_until IS NULL))
);
CREATE UNIQUE INDEX outbound_deliveries_request_idx
  ON public.outbound_deliveries (user_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX outbound_deliveries_recovery_idx
  ON public.outbound_deliveries (updated_at, id)
  WHERE status IN ('pending', 'sending', 'accepted');
CREATE INDEX outbound_deliveries_sent_message_idx ON public.outbound_deliveries (sent_message_id);

-- These references protect composer uploads while delivery/copy repair is
-- unresolved. They are released after the sent copy has its own attachment rows.
CREATE TABLE public.outbound_delivery_uploads (
  delivery_id uuid NOT NULL REFERENCES public.outbound_deliveries(id) ON DELETE CASCADE,
  outbound_attachment_id uuid NOT NULL REFERENCES public.outbound_attachments(id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (delivery_id, outbound_attachment_id)
);
CREATE INDEX outbound_delivery_uploads_attachment_idx
  ON public.outbound_delivery_uploads (outbound_attachment_id);

ALTER TABLE public.outbound_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_delivery_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_deliveries, public.outbound_delivery_uploads
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outbound_deliveries, public.outbound_delivery_uploads
  TO service_role;

ALTER TABLE public.scheduled_sends DROP CONSTRAINT scheduled_sends_status_check;
ALTER TABLE public.scheduled_sends ADD CONSTRAINT scheduled_sends_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'uncertain'));
-- Legacy attempts have no trustworthy first-dispatch timestamp. The latest
-- lease cannot safely establish a new provider idempotency window.
UPDATE public.scheduled_sends
SET status = 'uncertain', claimed_at = NULL,
    last_error = 'Delivery needs confirmation before retrying (legacy attempt)'
WHERE status = 'sending' OR (status IN ('pending', 'failed') AND attempts > 0);

COMMIT;
