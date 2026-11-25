-- Opaque, short-lived event tokens let an authenticated browser resolve an
-- inbound-message Realtime ping without broadcasting mailbox content.
BEGIN;

CREATE TABLE public.browser_notification_events (
  event_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message_id    uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  claim_token   uuid,
  claimed_until timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX browser_notification_events_created_idx
  ON public.browser_notification_events (created_at);

ALTER TABLE public.browser_notification_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.browser_notification_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_inbox_changed()
RETURNS trigger AS $$
DECLARE
  notification_event_id uuid;
BEGIN
  -- Notification plumbing must never abort message ingestion.
  IF TG_OP = 'INSERT' AND NOT NEW.is_sent THEN
    BEGIN
      INSERT INTO public.browser_notification_events (user_id, message_id)
      VALUES (NEW.user_id, NEW.id)
      RETURNING event_id INTO notification_event_id;
    EXCEPTION WHEN OTHERS THEN
      notification_event_id := NULL;
    END;

    BEGIN
      DELETE FROM public.browser_notification_events
      WHERE created_at < clock_timestamp() - interval '24 hours';
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  BEGIN
    PERFORM realtime.send(
      jsonb_strip_nulls(
        jsonb_build_object('op', TG_OP, 'event_id', notification_event_id)
      ),
      'inbox-changed',
      'inbox:' || COALESCE(NEW.user_id, OLD.user_id)::text,
      false
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.notify_inbox_changed() SET search_path = pg_catalog;

COMMIT;
