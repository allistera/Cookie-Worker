-- 0037_document_templates.sql
-- Reusable Editor.js document templates. Creating a document from one copies
-- its title, emoji, and block content; later template edits never mutate
-- documents that have already been created.

BEGIN;

CREATE TABLE public.document_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  emoji      text NOT NULL DEFAULT '📄',
  blocks     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX document_templates_user_updated_idx
  ON public.document_templates (user_id, updated_at DESC);

ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.document_templates FROM anon, authenticated;

COMMIT;
