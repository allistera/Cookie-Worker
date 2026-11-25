-- Compare metadata as a row, keeping large bodies out of JSON conversion.
-- Generate the column list from the schema so no existing metadata is lost.
-- Future message-column migrations must regenerate this function as needed.
BEGIN;
DO $migration$
DECLARE
  new_columns text;
  old_columns text;
BEGIN
  SELECT string_agg(format('n.%I', attname), ', ' ORDER BY attnum),
         string_agg(format('o.%I', attname), ', ' ORDER BY attnum)
    INTO new_columns, old_columns
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.messages'::regclass AND attnum > 0 AND NOT attisdropped
      AND attname NOT IN ('search_indexed_at', 'body_text', 'body_html');
  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION public.notify_inbox_updated_statement()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
    DECLARE target_user uuid;
    BEGIN
      FOR target_user IN
        SELECT DISTINCT n.user_id FROM changed_new n JOIN changed_old o ON o.id = n.id
        WHERE CASE
          WHEN n.search_indexed_at IS NOT DISTINCT FROM o.search_indexed_at THEN true
          WHEN ROW(%s) IS DISTINCT FROM ROW(%s) THEN true
          WHEN n.body_text IS DISTINCT FROM o.body_text THEN true
          ELSE n.body_html IS DISTINCT FROM o.body_html
        END
      LOOP
        BEGIN
          PERFORM realtime.send(jsonb_build_object('op', TG_OP), 'inbox-changed',
            'inbox:' || target_user::text, true);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END LOOP;
      RETURN NULL;
    END;
    $body$;
  $function$, new_columns, old_columns);
END;
$migration$;
COMMIT;
