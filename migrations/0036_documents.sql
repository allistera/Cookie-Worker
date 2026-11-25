-- 0036_documents.sql
-- The Documents app: a Paper-style notes workspace (nested folders + block
-- documents), served from /api/tasks?resource=documents because the Vercel
-- Hobby function cap keeps new endpoints on the resource= dispatch pattern.
--
-- Folder deletion cascades to sub-folders (matching the recursive delete in
-- the UI) while documents in a deleted folder fall back to the root via
-- SET NULL rather than being destroyed with it.

BEGIN;

CREATE TABLE public.document_folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES public.document_folders(id) ON DELETE CASCADE,
  title      text NOT NULL,
  emoji      text NOT NULL DEFAULT '📁',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The sidebar tree loads every folder the user owns in one query.
CREATE INDEX document_folders_user_idx ON public.document_folders (user_id);

CREATE TABLE public.documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  folder_id  uuid REFERENCES public.document_folders(id) ON DELETE SET NULL,
  title      text NOT NULL DEFAULT '',
  emoji      text NOT NULL DEFAULT '🔹',
  starred    boolean NOT NULL DEFAULT false,
  -- Editor.js block array, stored verbatim; the list endpoints never read it.
  blocks     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sidebar + dashboard listing: the user's documents, most recent first.
CREATE INDEX documents_user_updated_idx ON public.documents (user_id, updated_at DESC);

ALTER TABLE public.document_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.document_folders FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.documents FROM anon, authenticated;

COMMIT;
