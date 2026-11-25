-- When a message was marked done. AI Today's email triage (Cookie-Worker's
-- data-enricher, read back through cookie-web-tasks) now includes mail marked
-- done within the last 24 hours alongside mail that arrived in that window,
-- and shows those rows as done rather than dropping them. is_archived alone
-- cannot say when that happened, and messages has no updated_at (0055).
--
-- The stamp is kept by a trigger rather than by each writer because done is
-- written from several places: PATCH /messages (the Done button, AI Today,
-- iOS, the MCP organise tool), conditions rules at storage time, AI rules in
-- enrichment, and auto-archive. Moving a message back to the inbox clears it,
-- so a message done twice reports the latest time. Mail already done before
-- this migration keeps a null stamp and is treated as done at an unknown
-- time, which the 24-hour window excludes.
--
-- The partial index serves the enricher's "done in the last day" predicate.
-- It is empty at creation (every existing stamp is null), so building it
-- inside the migration's transaction is immediate.
BEGIN;

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE FUNCTION public.stamp_message_archived_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_archived AND NEW.archived_at IS NULL THEN
      NEW.archived_at := now();
    END IF;
  ELSIF NEW.is_archived AND NOT OLD.is_archived THEN
    NEW.archived_at := now();
  ELSIF NOT NEW.is_archived THEN
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_stamp_archived_at
  BEFORE INSERT OR UPDATE OF is_archived ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.stamp_message_archived_at();

CREATE INDEX IF NOT EXISTS messages_recently_done_idx
  ON public.messages (user_id, archived_at DESC)
  WHERE archived_at IS NOT NULL;

COMMIT;
