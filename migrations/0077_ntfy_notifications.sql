-- Queue opt-in inbound-mail notifications for the ntfy bridge. The queue is
-- deliberately separate from browser_notification_events because a browser
-- acknowledgement must not race or delete a mobile notification.
BEGIN;

CREATE TABLE public.ntfy_subscriptions (
  user_id    uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  topic      text NOT NULL UNIQUE,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ntfy_notification_events (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message_id       uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  attempts         integer NOT NULL DEFAULT 0,
  last_attempt_at  timestamptz,
  published_at     timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ntfy_notification_events_pending_idx
  ON public.ntfy_notification_events (created_at)
  WHERE published_at IS NULL;

ALTER TABLE public.ntfy_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ntfy_notification_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ntfy_subscriptions, public.ntfy_notification_events
  FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_inbox_changed()
RETURNS trigger AS $$
DECLARE
  notification_event_id uuid;
  thread_muted boolean;
BEGIN
  IF TG_OP = 'INSERT' AND NOT NEW.is_sent THEN
    BEGIN
      SELECT t.is_muted INTO thread_muted
      FROM public.threads t
      WHERE t.id = NEW.thread_id AND t.user_id = NEW.user_id
      FOR SHARE;

      IF NOT COALESCE(thread_muted, false) THEN
        INSERT INTO public.browser_notification_events (user_id, message_id)
        VALUES (NEW.user_id, NEW.id)
        RETURNING event_id INTO notification_event_id;

        INSERT INTO public.ntfy_notification_events (user_id, message_id)
        SELECT NEW.user_id, NEW.id
        WHERE EXISTS (
          SELECT 1 FROM public.ntfy_subscriptions
          WHERE user_id = NEW.user_id AND enabled
        )
        ON CONFLICT (message_id) DO NOTHING;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Notification failures must never abort mail delivery.
      notification_event_id := NULL;
    END;

    BEGIN
      DELETE FROM public.browser_notification_events
      WHERE created_at < clock_timestamp() - interval '24 hours';
      DELETE FROM public.ntfy_notification_events
      WHERE created_at < clock_timestamp() - interval '24 hours';
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  BEGIN
    PERFORM realtime.send(
      jsonb_strip_nulls(jsonb_build_object('op', TG_OP, 'event_id', notification_event_id)),
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
