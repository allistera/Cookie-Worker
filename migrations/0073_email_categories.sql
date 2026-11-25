-- 0073_email_categories.sql
-- User-defined Categories are single-valued message metadata, distinct from
-- the existing many-to-many Labels and from AI Auto Archive classifications.

BEGIN;

CREATE TABLE public.email_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text NOT NULL,
  description text,
  UNIQUE (user_id, name)
);

ALTER TABLE public.messages
  ADD COLUMN category_id uuid REFERENCES public.email_categories(id) ON DELETE SET NULL;

CREATE INDEX messages_category_idx
  ON public.messages (category_id)
  WHERE category_id IS NOT NULL;

ALTER TABLE public.email_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.email_categories FROM anon, authenticated;

COMMIT;
