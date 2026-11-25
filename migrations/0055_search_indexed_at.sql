-- When a row was last successfully pushed to Meilisearch. NULL means never
-- indexed.
--
-- documents.updated_at exists (bumped on every edit), so its partial index
-- can drift on "never indexed OR indexed before the last edit" — the same
-- condition the weekly sweep filters on.
--
-- messages has no updated_at column (see migration 0001 — messages get
-- created_at only; edits like is_archived/is_starred don't touch a
-- last-modified column). Its partial index can therefore only drift on
-- "never indexed": an edit to an already-indexed message will not be
-- detected as drift and will not be re-pushed by the sweep. That matches
-- current behaviour (a flag change doesn't re-sync to Meilisearch today
-- either), but it is a real gap — see scripts/repair-search-drift.js in
-- Cookie-Worker for where this is tracked. Do not "fix" this back to
-- matching documents' index without adding messages.updated_at first — the
-- index predicate must match the query predicate exactly or Postgres won't
-- use it.

BEGIN;

ALTER TABLE public.documents ADD COLUMN search_indexed_at timestamptz;
ALTER TABLE public.messages ADD COLUMN search_indexed_at timestamptz;

-- Partial indexes: the sweep only ever asks for drifted rows.
CREATE INDEX documents_search_drift_idx ON public.documents (updated_at)
  WHERE search_indexed_at IS NULL OR search_indexed_at < updated_at;
CREATE INDEX messages_search_drift_idx ON public.messages (created_at)
  WHERE search_indexed_at IS NULL;

COMMIT;
