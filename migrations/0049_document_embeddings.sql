-- 0049_document_embeddings.sql
-- Semantic search: pgvector embeddings on documents, mirroring
-- 0005_message_embeddings.sql. Vectors come from OpenAI text-embedding-3-small
-- (1536 dims), computed from content_text (see 0048); embedding_model records
-- the producer so rows can be re-embedded if the model ever changes. The
-- `vector` extension is already created by 0005.

BEGIN;

ALTER TABLE documents
  ADD COLUMN embedding       vector(1536),  -- null until embedded (save-time or backfill)
  ADD COLUMN embedding_model text;

CREATE INDEX documents_embedding_idx ON documents
  USING hnsw (embedding vector_cosine_ops);

COMMIT;
