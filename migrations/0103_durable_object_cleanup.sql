-- Deleting metadata must never lose the only pointer to private bytes.
-- Jobs and image tombstones deliberately have no users FK: account deletion
-- must leave enough information for the next cleanup run.
BEGIN;

CREATE TABLE public.object_cleanup_jobs (
  storage text NOT NULL CHECK (storage IN ('blob', 'r2')),
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  delete_started_at timestamptz,
  deleted_at timestamptz,
  PRIMARY KEY (storage, object_key)
);
CREATE INDEX object_cleanup_due_idx
  ON public.object_cleanup_jobs (available_at)
  WHERE deleted_at IS NULL;

CREATE TABLE public.document_images (
  pathname text PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  unreferenced_at timestamptz DEFAULT now(),
  deleting_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX document_images_unreferenced_idx
  ON public.document_images (unreferenced_at)
  WHERE deleting_at IS NULL AND unreferenced_at IS NOT NULL;

CREATE TABLE public.document_image_references (
  source_kind text NOT NULL CHECK (source_kind IN ('document', 'template')),
  source_id uuid NOT NULL,
  pathname text NOT NULL REFERENCES public.document_images(pathname),
  PRIMARY KEY (source_kind, source_id, pathname)
);
CREATE INDEX document_image_references_path_idx
  ON public.document_image_references (pathname);

CREATE TABLE public.object_cleanup_cursors (
  name text PRIMARY KEY,
  cursor text
);

-- One key lock orders registration, removal, and cleanup's final reference
-- check. A completed tombstone also refuses a delayed client registration.
CREATE FUNCTION public.track_object_cleanup() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  old_key text;
  new_key text;
  started timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_key := to_jsonb(OLD) ->> TG_ARGV[1]; END IF;
  IF TG_OP <> 'DELETE' THEN new_key := to_jsonb(NEW) ->> TG_ARGV[1]; END IF;
  IF TG_WHEN = 'BEFORE' THEN
    IF new_key IS NOT NULL AND new_key IS DISTINCT FROM old_key THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('object-cleanup:' || TG_ARGV[0] || ':' || new_key, 0));
      SELECT delete_started_at INTO started FROM object_cleanup_jobs
        WHERE storage = TG_ARGV[0] AND object_key = new_key FOR UPDATE;
      IF started IS NOT NULL THEN
        RAISE EXCEPTION 'Stored object has expired; upload it again' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF old_key IS NOT NULL AND old_key IS DISTINCT FROM new_key THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('object-cleanup:' || TG_ARGV[0] || ':' || old_key, 0));
    INSERT INTO object_cleanup_jobs (storage, object_key)
      VALUES (TG_ARGV[0], old_key)
      ON CONFLICT (storage, object_key) DO UPDATE
      SET available_at = LEAST(object_cleanup_jobs.available_at, now());
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER document_files_cleanup
  AFTER DELETE OR UPDATE OF object_key ON public.document_files
  FOR EACH ROW EXECUTE FUNCTION public.track_object_cleanup('r2', 'object_key');
CREATE TRIGGER document_files_storage_guard
  BEFORE INSERT OR UPDATE OF object_key ON public.document_files
  FOR EACH ROW EXECUTE FUNCTION public.track_object_cleanup('r2', 'object_key');
CREATE TRIGGER task_comments_cleanup
  AFTER DELETE OR UPDATE OF object_key ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.track_object_cleanup('r2', 'object_key');
CREATE TRIGGER task_comments_storage_guard
  BEFORE INSERT OR UPDATE OF object_key ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.track_object_cleanup('r2', 'object_key');
CREATE TRIGGER attachments_cleanup
  AFTER DELETE OR UPDATE OF blob_url ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION public.track_object_cleanup('blob', 'blob_url');
CREATE TRIGGER attachments_storage_guard
  BEFORE INSERT OR UPDATE OF blob_url ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION public.track_object_cleanup('blob', 'blob_url');
CREATE TRIGGER outbound_attachments_cleanup
  AFTER DELETE OR UPDATE OF blob_url ON public.outbound_attachments
  FOR EACH ROW EXECUTE FUNCTION public.track_object_cleanup('blob', 'blob_url');
CREATE TRIGGER outbound_attachments_storage_guard
  BEFORE INSERT OR UPDATE OF blob_url ON public.outbound_attachments
  FOR EACH ROW EXECUTE FUNCTION public.track_object_cleanup('blob', 'blob_url');

-- Read string leaves rather than relying on one Editor.js block version.
-- Only canonical, owner-scoped private document-image URLs count. Existing
-- generated names (including Vercel's old random suffix) contain this alphabet.
CREATE FUNCTION public.document_image_paths(content jsonb, owner_id uuid)
RETURNS SETOF text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT DISTINCT substring(value #>> '{}' FROM
    '^https://[A-Za-z0-9-]+[.]private[.]blob[.]vercel-storage[.]com/(documents/'
    || owner_id::text || '/[A-Za-z0-9._-]+)$')
  FROM jsonb_path_query(content, 'strict $.** ? (@.type() == "string")') AS strings(value)
  WHERE (value #>> '{}') ~
    ('^https://[A-Za-z0-9-]+[.]private[.]blob[.]vercel-storage[.]com/documents/'
      || owner_id::text || '/[A-Za-z0-9._-]+$');
$$;

CREATE FUNCTION public.track_document_images() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  owner_id uuid;
  source uuid;
  old_paths text[] := ARRAY[]::text[];
  new_paths text[] := ARRAY[]::text[];
  image_path text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    owner_id := OLD.user_id;
    source := OLD.id;
  ELSE
    owner_id := NEW.user_id;
    source := NEW.id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('document-images:' || owner_id::text, 0));
  IF TG_OP <> 'INSERT' THEN
    old_paths := ARRAY(SELECT public.document_image_paths(OLD.blocks, OLD.user_id));
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_paths := ARRAY(SELECT public.document_image_paths(NEW.blocks, NEW.user_id));
  END IF;
  FOREACH image_path IN ARRAY old_paths || new_paths LOOP
    INSERT INTO document_images (pathname, user_id) VALUES (image_path, owner_id)
      ON CONFLICT (pathname) DO NOTHING;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM document_images
    WHERE pathname = ANY(new_paths) AND deleting_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Document image has expired; upload it again' USING ERRCODE = '23514';
  END IF;
  DELETE FROM document_image_references WHERE source_kind = TG_ARGV[0] AND source_id = source;
  INSERT INTO document_image_references (source_kind, source_id, pathname)
    SELECT TG_ARGV[0], source, unnest(new_paths) ON CONFLICT DO NOTHING;
  UPDATE document_images i SET unreferenced_at =
    CASE WHEN EXISTS (SELECT 1 FROM document_image_references r WHERE r.pathname = i.pathname)
      THEN NULL ELSE COALESCE(i.unreferenced_at, now()) END
    WHERE i.pathname = ANY(old_paths || new_paths);
  RETURN NULL;
END;
$$;

CREATE TRIGGER documents_image_references
  AFTER INSERT OR UPDATE OF blocks OR DELETE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.track_document_images('document');
CREATE TRIGGER templates_image_references
  AFTER INSERT OR UPDATE OF blocks OR DELETE ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public.track_document_images('template');

-- Backfill without rewriting documents or advancing their revision tokens.
INSERT INTO public.document_images (pathname, user_id, unreferenced_at)
  SELECT p.pathname, d.user_id, NULL
  FROM (
    SELECT user_id, blocks FROM public.documents
    UNION ALL SELECT user_id, blocks FROM public.document_templates
  ) d CROSS JOIN LATERAL public.document_image_paths(d.blocks, d.user_id) AS p(pathname)
  ON CONFLICT (pathname) DO NOTHING;
INSERT INTO public.document_image_references (source_kind, source_id, pathname)
  SELECT 'document', d.id, p.pathname
    FROM public.documents d
    CROSS JOIN LATERAL public.document_image_paths(d.blocks, d.user_id) AS p(pathname)
  UNION ALL
  SELECT 'template', t.id, p.pathname
    FROM public.document_templates t
    CROSS JOIN LATERAL public.document_image_paths(t.blocks, t.user_id) AS p(pathname);

ALTER TABLE public.object_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_image_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_cleanup_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.object_cleanup_jobs, public.document_images,
  public.document_image_references, public.object_cleanup_cursors FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.object_cleanup_jobs, public.document_images,
  public.document_image_references, public.object_cleanup_cursors TO service_role;
REVOKE ALL ON FUNCTION public.track_object_cleanup(), public.track_document_images(),
  public.document_image_paths(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.track_object_cleanup(), public.track_document_images(),
  public.document_image_paths(jsonb, uuid) TO service_role;

COMMIT;
