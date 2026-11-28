-- A draft that is not starred is deleted 30 days after its last save by
-- mail-app-ingest's draft retention sweep. Starring a draft keeps it.
--
-- retention_from is the earliest moment those 30 days may count from, besides
-- the last save: when this migration ran for a draft that already existed, so
-- none is deleted before its owner could have starred it, and when a star was
-- removed. It is kept apart from updated_at, which is the version autosave
-- checks and the order of the Drafts list.
--
-- Apply it before deploying cookie-web-drafts and mail-app-ingest from the
-- same change, since both name the new columns.
BEGIN;

ALTER TABLE public.drafts
  ADD COLUMN is_starred boolean NOT NULL DEFAULT false,
  ADD COLUMN retention_from timestamptz NOT NULL DEFAULT now();

COMMIT;
