-- Uploaded files that live in the Documents folder tree next to documents.
-- Bytes live in the private R2 bucket cookie-files under object_key; this
-- table is the metadata and the ownership check. Files follow the document
-- rule on folder deletion: they fall back to the root rather than being
-- destroyed with the folder.
BEGIN;

CREATE TABLE public.document_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  folder_id   uuid REFERENCES public.document_folders(id) ON DELETE SET NULL,
  name        text NOT NULL,
  mime_type   text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes  bigint NOT NULL,
  object_key  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_files_folder_idx
  ON public.document_files (user_id, folder_id, created_at DESC);

ALTER TABLE public.document_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.document_files FROM anon, authenticated;

COMMIT;
