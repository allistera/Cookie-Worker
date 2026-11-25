-- Inbox topics were public: anyone with the anon key and a user id could
-- subscribe or inject pings. realtime.send's fourth argument is the private
-- flag. Subscribers must present an Auth0 access token that Supabase accepts
-- as a third-party JWT (role authenticated, sub = users.auth0_sub) and join
-- the channel with private: true. The lookup function is security definer
-- because users has no policies for the authenticated role.
--
-- Apply this with the Cookie-Web release that sets that token on the
-- realtime client. Older pages subscribe publicly and will stop receiving
-- pings once these functions are replaced.

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_inbox_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
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

  BEGIN
    PERFORM realtime.send(
      jsonb_strip_nulls(jsonb_build_object('op', TG_OP, 'event_id', notification_event_id)),
      'inbox-changed', 'inbox:' || COALESCE(NEW.user_id, OLD.user_id)::text, true
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_inbox_updated_statement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  target_user uuid;
BEGIN
  FOR target_user IN
    SELECT DISTINCT n.user_id
    FROM changed_new n
    JOIN changed_old o ON o.id = n.id
    WHERE CASE
      WHEN n.search_indexed_at IS DISTINCT FROM o.search_indexed_at
        THEN (to_jsonb(n) - 'search_indexed_at') <> (to_jsonb(o) - 'search_indexed_at')
      ELSE true
    END
  LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('op', TG_OP), 'inbox-changed', 'inbox:' || target_user::text, true
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_inbox_deleted_statement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  target_user uuid;
BEGIN
  FOR target_user IN SELECT DISTINCT o.user_id FROM changed_old o LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('op', TG_OP), 'inbox-changed', 'inbox:' || target_user::text, true
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_inbox_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_inbox_updated_statement() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_inbox_deleted_statement() FROM PUBLIC, anon, authenticated;

-- Supabase-only: authorize the private inbox topic for the Auth0 subject.
-- Vanilla Postgres used in unit tests has neither auth.jwt nor realtime.messages.
DO $$
BEGIN
  IF to_regprocedure('auth.jwt()') IS NULL OR to_regclass('realtime.messages') IS NULL THEN
    RETURN;
  END IF;

  -- Supabase owns this table and enables RLS itself. Its postgres role can
  -- manage policies through supautils, but cannot ALTER the managed table.
  -- Check the prerequisite without requiring ownership or silently proceeding
  -- with a policy that would not be enforced.
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid = 'realtime.messages'::regclass) THEN
    RAISE EXCEPTION 'realtime.messages must already have row level security enabled by Supabase';
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.inbox_topic_for_auth_subject()
    RETURNS text
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $body$
      SELECT 'inbox:' || id::text
      FROM public.users
      WHERE auth0_sub = (SELECT auth.jwt() ->> 'sub')
      LIMIT 1
    $body$
  $fn$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.inbox_topic_for_auth_subject() FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.inbox_topic_for_auth_subject() TO authenticated';
  EXECUTE 'DROP POLICY IF EXISTS cookie_inbox_broadcast_receive ON realtime.messages';
  EXECUTE $policy$
    CREATE POLICY cookie_inbox_broadcast_receive
    ON realtime.messages
    FOR SELECT
    TO authenticated
    USING (
      extension = 'broadcast'
      AND realtime.topic() = public.inbox_topic_for_auth_subject()
    )
  $policy$;
END $$;

COMMIT;
