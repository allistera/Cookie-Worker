-- The arrival snapshot proves the responder was enabled when mail was stored.
-- No backfill: existing mail must never become eligible after enabling it.
BEGIN;

ALTER TABLE public.messages
  ADD COLUMN out_of_office_revision bigint,
  ADD COLUMN auto_reply_suppressed boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.snapshot_out_of_office_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE settings jsonb;
BEGIN
  NEW.out_of_office_revision := NULL;
  IF NOT NEW.is_sent THEN
    SELECT prefs -> 'outOfOffice' INTO settings FROM public.users WHERE id = NEW.user_id;
    IF settings ->> 'enabled' = 'true' THEN
      NEW.out_of_office_revision := (settings ->> 'revision')::bigint;
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Auxiliary responder state must never break inbound storage/forwarding.
  NEW.out_of_office_revision := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.snapshot_out_of_office_revision() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER messages_snapshot_out_of_office
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_out_of_office_revision();

CREATE INDEX messages_out_of_office_arrivals_idx
  ON public.messages (user_id, out_of_office_revision, created_at, id)
  WHERE out_of_office_revision IS NOT NULL AND NOT is_sent;

CREATE TABLE public.out_of_office_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  settings_revision bigint NOT NULL,
  recipient text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'suppressed', 'failed', 'uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  quota_reserved boolean NOT NULL DEFAULT false,
  first_attempt_at timestamptz,
  retry_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_token uuid,
  provider_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  resolved_at timestamptz,
  sent_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  UNIQUE (user_id, message_id)
);
CREATE INDEX out_of_office_deliveries_due_idx
  ON public.out_of_office_deliveries (next_attempt_at, created_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX out_of_office_deliveries_review_idx
  ON public.out_of_office_deliveries (user_id, created_at)
  WHERE status IN ('uncertain', 'failed');
CREATE INDEX out_of_office_deliveries_message_idx ON public.out_of_office_deliveries (message_id);
CREATE INDEX out_of_office_deliveries_sent_message_idx ON public.out_of_office_deliveries (sent_message_id);

CREATE TABLE public.out_of_office_senders (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  sender text NOT NULL,
  delivery_id uuid NOT NULL REFERENCES public.out_of_office_deliveries(id) ON DELETE CASCADE,
  next_allowed_at timestamptz NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, sender)
);
CREATE INDEX out_of_office_senders_delivery_idx ON public.out_of_office_senders (delivery_id);

ALTER TABLE public.out_of_office_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.out_of_office_senders ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.out_of_office_deliveries, public.out_of_office_senders
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.out_of_office_deliveries, public.out_of_office_senders
  TO service_role;

COMMENT ON COLUMN public.messages.auto_reply_suppressed IS
  'Set true before screening/blocking becomes visible; responder rechecks before dispatch. Never changes forwarding.';
COMMENT ON TABLE public.out_of_office_deliveries IS
  'Server-only immutable auto-reply payloads and durable receipts; Auth0 ownership is enforced by Workers.';

COMMIT;
