-- 0047_daily_note_calendar_events.sql
-- Links a calendar_events row to the Daily-note block that created it, so a
-- typed "10:00 - 11:00 - Title" line in a daily document can be kept in sync
-- with its calendar event (edit the line updates the event, delete the line
-- deletes it) instead of creating a fresh duplicate on every autosave.

BEGIN;

ALTER TABLE public.calendar_events
  ADD COLUMN source_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  ADD COLUMN source_block_id text;

-- Partial + unique: at most one event per (document, block) pair, used as
-- the ON CONFLICT target for an idempotent upsert on every save. Deleting
-- the note detaches rather than deletes its events (ON DELETE SET NULL
-- above) — losing a note shouldn't silently take real calendar commitments
-- with it.
CREATE UNIQUE INDEX calendar_events_source_block_idx
  ON public.calendar_events (source_document_id, source_block_id)
  WHERE source_document_id IS NOT NULL;

COMMIT;
