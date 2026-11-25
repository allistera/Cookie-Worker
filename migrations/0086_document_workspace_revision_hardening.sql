-- Pin the 0075 revision trigger's search path and keep its table server-only.
BEGIN;

-- Same body as 0075, with schema-qualified names so a caller's search_path
-- cannot redirect the trigger. Existing triggers keep pointing at it.
CREATE OR REPLACE FUNCTION public.bump_document_workspace_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE owner_id uuid;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  INSERT INTO public.document_workspace_revisions AS r (user_id, revision)
    SELECT owner_id, 1 WHERE EXISTS (SELECT 1 FROM public.users WHERE id = owner_id)
    ON CONFLICT (user_id) DO UPDATE SET revision = r.revision + 1;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_document_workspace_revision() FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.document_workspace_revisions FROM anon, authenticated;

COMMIT;
