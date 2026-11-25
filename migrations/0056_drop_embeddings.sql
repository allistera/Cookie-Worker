-- 0056_drop_embeddings.sql
-- Meilisearch owns retrieval; its openAi embedder generates and stores the
-- vectors now. Nothing reads or writes these columns as of phase 2, and the
-- code that stopped writing them is deployed and verified in production.
--
-- One-way: restoring the pgvector path means re-embedding the whole corpus.
--
-- Dependency check before writing this: pg_depend reports no view or
-- generated column on either column, and the only dependents are the two
-- HNSW indexes dropped below (created in 0005 and 0049). The `vector`
-- extension stays — dropping it is a separate decision with a wider blast
-- radius, and an unused extension costs nothing.

BEGIN;

DROP INDEX IF EXISTS public.messages_embedding_idx;
DROP INDEX IF EXISTS public.documents_embedding_idx;

ALTER TABLE public.messages DROP COLUMN IF EXISTS embedding;
ALTER TABLE public.messages DROP COLUMN IF EXISTS embedding_model;
ALTER TABLE public.documents DROP COLUMN IF EXISTS embedding;
ALTER TABLE public.documents DROP COLUMN IF EXISTS embedding_model;

COMMIT;
