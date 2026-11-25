-- Exact, owner-controlled sender decisions. Historical mail stays allowed;
-- screening is off unless explicitly enabled in users.prefs.senderScreening.
BEGIN;

CREATE TABLE public.sender_decisions (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address = lower(btrim(address)) AND length(address) BETWEEN 3 AND 320),
  decision text NOT NULL CHECK (decision IN ('accepted', 'blocked')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, address)
);
ALTER TABLE public.sender_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.sender_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sender_decisions TO service_role;

ALTER TABLE public.messages ADD COLUMN screening_status text NOT NULL DEFAULT 'allowed'
  CHECK (screening_status IN ('allowed', 'held', 'blocked'));
CREATE INDEX messages_screening_queue_idx ON public.messages (user_id, screening_status, sent_at DESC, id DESC)
  WHERE screening_status <> 'allowed' AND NOT is_deleted AND NOT is_sent;

CREATE FUNCTION public.screen_incoming_sender()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  sender_decision text;
  screening_enabled boolean;
BEGIN
  NEW.screening_status := 'allowed';
  IF NEW.is_sent THEN RETURN NEW; END IF;
  -- The ingest owner lock serializes these reads with settings/decision writes.
  -- Never take the responder lock inside this uncommitted arrival transaction.
  SELECT decision INTO sender_decision FROM public.sender_decisions
    WHERE user_id = NEW.user_id AND address = lower(btrim(NEW.from_address));
  SELECT COALESCE(prefs -> 'senderScreening' = 'true'::jsonb, false)
    INTO screening_enabled FROM public.users WHERE id = NEW.user_id;
  IF sender_decision = 'blocked' THEN
    NEW.screening_status := 'blocked';
  ELSIF COALESCE(screening_enabled, false) AND sender_decision IS DISTINCT FROM 'accepted' THEN
    NEW.screening_status := 'held';
  END IF;
  IF NEW.screening_status <> 'allowed' THEN NEW.auto_reply_suppressed := true; END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A failed preference lookup must preserve storage/forwarding without exposing
  -- an unreviewed message to alerts or automatic replies. The owner can restore it.
  NEW.screening_status := 'held';
  NEW.auto_reply_suppressed := true;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.screen_incoming_sender() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER messages_screen_sender BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.screen_incoming_sender();

CREATE OR REPLACE FUNCTION public.notify_inbox_changed()
RETURNS trigger AS $$
DECLARE
  notification_event_id uuid;
  thread_muted boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.search_indexed_at IS DISTINCT FROM OLD.search_indexed_at
     AND (to_jsonb(NEW) - 'search_indexed_at') = (to_jsonb(OLD) - 'search_indexed_at') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NOT NEW.is_sent AND NEW.screening_status = 'allowed' THEN
    BEGIN
      SELECT t.is_muted INTO thread_muted FROM public.threads t
        WHERE t.id = NEW.thread_id AND t.user_id = NEW.user_id FOR SHARE;
      IF NOT COALESCE(thread_muted, false) THEN
        INSERT INTO public.browser_notification_events (user_id, message_id)
          VALUES (NEW.user_id, NEW.id) RETURNING event_id INTO notification_event_id;
        INSERT INTO public.ntfy_notification_events (user_id, message_id)
          SELECT NEW.user_id, NEW.id WHERE EXISTS (
            SELECT 1 FROM public.ntfy_subscriptions WHERE user_id = NEW.user_id AND enabled
          ) ON CONFLICT (message_id) DO NOTHING;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      notification_event_id := NULL;
    END;
  END IF;
  -- Refresh pings still fire for held mail and disposition changes; they are
  -- mailbox invalidations, not permission to display a user-visible alert.
  BEGIN
    PERFORM realtime.send(
      jsonb_strip_nulls(jsonb_build_object('op', TG_OP, 'event_id', notification_event_id)),
      'inbox-changed', 'inbox:' || COALESCE(NEW.user_id, OLD.user_id)::text, false
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION public.notify_inbox_changed() SET search_path = pg_catalog;

COMMENT ON COLUMN public.messages.screening_status IS
  'Independent recoverable sender disposition. Restore preserves spam/read/archive state and never revives automatic replies.';
COMMENT ON TABLE public.sender_decisions IS
  'Server-only exact lowercased trimmed From addresses; no wildcard/domain or historical trust inference. Workers enforce verified Auth0 owner scope.';

COMMIT;
