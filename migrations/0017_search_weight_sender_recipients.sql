-- 0017_search_weight_sender_recipients.sql
-- Improve keyword-search relevance by rebuilding the generated `search`
-- tsvector so it:
--   * weights fields (A subject > B sender/recipients > C body), so a subject
--     or sender hit outranks a passing mention deep in a body, and
--   * indexes the sender and recipient addresses/names, which were previously
--     unsearchable (searching a person's name or address matched nothing).
--
-- Changing a GENERATED column's expression requires dropping and re-adding the
-- column; dropping it also drops the dependent GIN index, which we recreate.
-- The STORED column is recomputed for every existing row during the rewrite,
-- so no backfill step is needed. Additive and safe: no data is lost.
--
-- Recipient text is extracted with jsonb_path_query_array (IMMUTABLE, so it is
-- legal inside a generated column) over the {"to":[{name,address}],...} shape
-- api/send.js and the ingest worker store.

BEGIN;

ALTER TABLE messages DROP COLUMN search;

ALTER TABLE messages
  ADD COLUMN search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A')
    || setweight(
         to_tsvector('english',
           coalesce(from_name, '') || ' ' ||
           coalesce(from_address, '') || ' ' ||
           coalesce(jsonb_path_query_array(recipients, '$.**.address')::text, '') || ' ' ||
           coalesce(jsonb_path_query_array(recipients, '$.**.name ? (@ != null)')::text, '')
         ),
         'B')
    || setweight(to_tsvector('english', coalesce(body_text, '')), 'C')
  ) STORED;

CREATE INDEX messages_search_idx ON messages USING gin (search);

COMMIT;
