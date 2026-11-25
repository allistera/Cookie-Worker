-- 0042_recipients_trgm_index.sql
-- The to: search operator (api/_lib/retrieval.js filterClause) matches with
-- `m.recipients::text ILIKE '%...%'`. jsonb cast to text can't use a btree or
-- the existing GIN full-text index (whose tsvector tokenizes email addresses
-- as single lexemes, so it can't match a partial address the way ILIKE does).
-- A trigram index on the same cast expression keeps the exact ILIKE semantics
-- while making the predicate indexable.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX messages_recipients_text_trgm_idx
  ON messages USING gin ((recipients::text) gin_trgm_ops);

COMMIT;
