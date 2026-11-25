-- Live inbox: broadcast a content-free ping over Supabase Realtime whenever
-- a message row changes, so clients know to refetch through the normal
-- Auth0-protected API. We do NOT use postgres_changes (no RLS on these
-- tables — that would leak row data to anyone holding the anon key), so the
-- payload here carries only the operation type, never email content.
BEGIN;

CREATE OR REPLACE FUNCTION notify_inbox_changed()
RETURNS trigger AS $$
BEGIN
  -- Realtime failures must never abort message ingestion — liveness of the
  -- live-inbox feature is strictly secondary to ingestion correctness.
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object('op', TG_OP),
      'inbox-changed',
      'inbox:' || COALESCE(NEW.user_id, OLD.user_id)::text,
      false -- public channel: no row data in the payload, so no RLS needed
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_notify_inbox_changed
  AFTER INSERT OR UPDATE OR DELETE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION notify_inbox_changed();

COMMIT;
