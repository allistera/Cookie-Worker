-- Inline images, calendar invites, and signature parts routinely arrive with
-- no filename parameter; the ingest worker stores their metadata with NULL.
BEGIN;

ALTER TABLE attachments ALTER COLUMN filename DROP NOT NULL;

COMMIT;
