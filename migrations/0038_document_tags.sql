-- 0038_document_tags.sql
-- Explicit tags for organizing documents. Tags are normalized by the API and
-- included in document list rows so the sidebar can group them without
-- loading Editor.js block bodies.

BEGIN;

ALTER TABLE public.documents
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT documents_tags_limit CHECK (cardinality(tags) <= 20);

COMMIT;
