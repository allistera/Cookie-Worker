-- Search moved to Meilisearch (Cookie-Worker shared/meili.js); nothing reads
-- the pgvector embeddings or the generated tsvector columns any more, yet
-- every message and document write still maintained their indexes. Drop the
-- indexes and keep the columns, so a later migration can remove those once
-- no deployed code selects them.
BEGIN;

DROP INDEX IF EXISTS public.messages_embedding_idx;
DROP INDEX IF EXISTS public.documents_embedding_idx;
DROP INDEX IF EXISTS public.messages_search_idx;
DROP INDEX IF EXISTS public.documents_search_idx;

COMMIT;
