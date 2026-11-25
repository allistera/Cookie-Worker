-- notify_inbox_changed() fires on every messages UPDATE with no column filter,
-- so search-index stamps (search_indexed_at, written by every Meilisearch sync
-- and the 15-minute drift sweep) pinged every open Cookie tab into refetching
-- an inbox that had not visibly changed. Skip the broadcast when an UPDATE
-- touched nothing but that column.
--
-- The trigger also swept day-old browser and ntfy notification events inside
-- every inbound INSERT, spending the ingest's store budget on housekeeping.
-- Cookie-Worker's mail-app-ingest cron owns that sweep now
-- (src/notificationEventsSweep.js); the trigger only queues and pings.
BEGIN;

CREATE OR REPLACE FUNCTION public.notify_inbox_changed()
RETURNS trigger AS $$
DECLARE
  notification_event_id uuid;
  thread_muted boolean;
BEGIN
  -- Cheap test first: only a changed stamp pays for the row comparison.
  IF TG_OP = 'UPDATE'
     AND NEW.search_indexed_at IS DISTINCT FROM OLD.search_indexed_at
     AND (to_jsonb(NEW) - 'search_indexed_at') = (to_jsonb(OLD) - 'search_indexed_at') THEN
    RETURN NEW;
  END IF;

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
