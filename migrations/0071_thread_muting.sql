-- Muting silences replies without archiving or changing unread state.
BEGIN;

ALTER TABLE public.threads ADD COLUMN is_muted boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.notify_inbox_changed()
RETURNS trigger AS $$
DECLARE
  notification_event_id uuid;
  thread_muted boolean;
BEGIN
  IF TG_OP = 'INSERT' AND NOT NEW.is_sent THEN
    BEGIN
      -- Serialize with mute/unmute updates while the reply is inserted.
      SELECT t.is_muted INTO thread_muted
      FROM public.threads t
      WHERE t.id = NEW.thread_id AND t.user_id = NEW.user_id
      FOR SHARE;

      IF NOT COALESCE(thread_muted, false) THEN
        INSERT INTO public.browser_notification_events (user_id, message_id)
        VALUES (NEW.user_id, NEW.id)
        RETURNING event_id INTO notification_event_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Notification failures must never abort mail delivery.
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
    -- Refresh the mailbox even when the new reply is muted.
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
