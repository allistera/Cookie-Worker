-- 0005_message_embeddings.sql
-- Semantic search: pgvector embeddings on messages. Vectors come from
-- OpenAI text-embedding-3-small (1536 dims); embedding_model records the
-- producer so rows can be re-embedded if the model ever changes.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE messages
  ADD COLUMN embedding       vector(1536),  -- null until embedded (ingest or backfill)
  ADD COLUMN embedding_model text;

CREATE INDEX messages_embedding_idx ON messages
  USING hnsw (embedding vector_cosine_ops);

COMMIT;
