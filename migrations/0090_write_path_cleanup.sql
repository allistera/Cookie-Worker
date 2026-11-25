-- Write-path cleanup: stop maintaining structures nothing reads, and stop
-- per-row work that only needs to happen once per statement.
--
-- 1. messages.search (0017) and documents.search (0048) are generated
--    tsvectors. Search moved to Meilisearch and 0081 dropped their indexes;
--    no Web, Worker or iOS code selects them, and no view, function or trigger
--    references them. Every message and document write still recomputed them.
-- 2. The pg_trgm GIN indexes from 0042 (recipients::text) and 0050
--    (from_address, from_name) served ILIKE search predicates that no longer
--    exist anywhere. pg_trgm is dropped without CASCADE, so anything else that
--    still depends on it fails this migration loudly instead of vanishing.
-- 3. documents_user_updated_idx (0036, user_id, updated_at DESC) is a strict
--    prefix of documents_workspace_page_idx (0074, user_id, updated_at DESC,
--    id DESC); both are plain, non-unique, non-partial btrees.
-- 4. document_files.folder_id (0076) is ON DELETE SET NULL with no index
--    leading on it, so deleting a folder scanned document_files.
-- 5. effective_sender_decision (0089) drops its SET search_path so the planner
--    can inline it. Every relation is schema-qualified, built-ins are
--    pg_catalog-qualified, it is SECURITY INVOKER and STABLE; signature,
--    result and grants are unchanged.
-- 6. The inbox ping keeps its per-row INSERT trigger (notification events
--    are per message), but UPDATE and DELETE now fire once per statement and
--    send one content-free ping per affected user instead of one per row. The
--    payload stays {"op": "UPDATE"} / {"op": "DELETE"} on topic inbox:<user>,
--    event inbox-changed; useRealtimeInbox.js reads only `op`. An UPDATE that
--    changed nothing but search_indexed_at still sends no ping (0080).
--
-- The 0075 workspace revision trigger is deliberately left on UPDATE OF
-- blocks: a content save bumps documents.updated_at, which the paged
-- workspace listing returns and orders by, and clients skip refetching
-- cached pages while the revision is unchanged.
BEGIN;

ALTER TABLE public.messages DROP COLUMN IF EXISTS search;
ALTER TABLE public.documents DROP COLUMN IF EXISTS search;

DROP INDEX IF EXISTS public.messages_recipients_text_trgm_idx;
DROP INDEX IF EXISTS public.messages_from_address_trgm_idx;
DROP INDEX IF EXISTS public.messages_from_name_trgm_idx;
DROP EXTENSION IF EXISTS pg_trgm;

DROP INDEX IF EXISTS public.documents_user_updated_idx;

CREATE INDEX IF NOT EXISTS document_files_folder_id_idx
  ON public.document_files (folder_id)
  WHERE folder_id IS NOT NULL;

-- Same signature and semantics as 0089. CREATE OR REPLACE keeps the existing
-- privileges and replaces the whole definition, including its SET clause.
CREATE OR REPLACE FUNCTION public.effective_sender_decision(p_user_id uuid, p_from_address text)
RETURNS TABLE (address text, decision text)
LANGUAGE sql STABLE AS $$
  SELECT d.address, d.decision
  FROM (SELECT pg_catalog.lower(pg_catalog.btrim(p_from_address)) AS sender) s
  CROSS JOIN LATERAL (SELECT pg_catalog.regexp_replace(s.sender, '^.*@', '') AS domain) dm
  JOIN public.sender_decisions d ON d.user_id = p_user_id
  WHERE d.address = s.sender
     OR (pg_catalog.left(d.address, 1) = '@' AND position('@' IN s.sender) > 0 AND (
           dm.domain = pg_catalog.substr(d.address, 2)
           OR pg_catalog.right(dm.domain, pg_catalog.length(d.address))
              = '.' || pg_catalog.substr(d.address, 2)))
  ORDER BY (d.address = s.sender) DESC, pg_catalog.length(d.address) DESC
  LIMIT 1
$$;

-- Statement-level pings for UPDATE and DELETE. A trigger with transition
-- tables cannot list columns or combine events, hence one trigger (and one
-- function, since each reads different transition tables) per event.
CREATE FUNCTION public.notify_inbox_updated_statement()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_user uuid;
BEGIN
  FOR target_user IN
    SELECT DISTINCT n.user_id
    FROM changed_new n
    JOIN changed_old o ON o.id = n.id
    -- Skip rows whose only change is the search-index stamp (0080). The CASE
    -- keeps the row comparison off rows whose stamp did not change.
    WHERE CASE
      WHEN n.search_indexed_at IS DISTINCT FROM o.search_indexed_at
        THEN (to_jsonb(n) - 'search_indexed_at') <> (to_jsonb(o) - 'search_indexed_at')
      ELSE true
    END
  LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('op', TG_OP), 'inbox-changed', 'inbox:' || target_user::text, false
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.notify_inbox_deleted_statement()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_user uuid;
BEGIN
  FOR target_user IN SELECT DISTINCT o.user_id FROM changed_old o LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('op', TG_OP), 'inbox-changed', 'inbox:' || target_user::text, false
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_inbox_updated_statement() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_inbox_deleted_statement() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS messages_notify_inbox_changed ON public.messages;
CREATE TRIGGER messages_notify_inbox_changed
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_changed();
CREATE TRIGGER messages_notify_inbox_updated
  AFTER UPDATE ON public.messages
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION public.notify_inbox_updated_statement();
CREATE TRIGGER messages_notify_inbox_deleted
  AFTER DELETE ON public.messages
  REFERENCING OLD TABLE AS changed_old
  FOR EACH STATEMENT EXECUTE FUNCTION public.notify_inbox_deleted_statement();

COMMIT;
