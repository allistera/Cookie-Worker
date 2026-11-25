-- 0048_document_search.sql
-- Keyword search for documents. content_text is a plain-text flattening of
-- title + Editor.js blocks (headers/paragraphs/list items/table cells/code/
-- image captions), computed in JS (flattenBlocksToText, api/_lib/documentText.js)
-- and written by the API alongside every title/blocks save. Kept as a real
-- column rather than deriving `search` straight from the jsonb blocks column
-- so the block-walking logic lives in exactly one place (JS), shared by both
-- the tsvector below and the embedding input in 0049.
--
-- Existing rows default content_text to '', so pre-existing documents are
-- title-only searchable until the backfill script runs (see
-- scripts/backfill-document-embeddings.js).

BEGIN;

ALTER TABLE documents
  ADD COLUMN content_text text NOT NULL DEFAULT '';

ALTER TABLE documents
  ADD COLUMN search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(content_text, '')), 'B')
  ) STORED;

CREATE INDEX documents_search_idx ON documents USING gin (search);

COMMIT;
