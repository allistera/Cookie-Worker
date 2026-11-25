-- Indexes that matching list/search queries can actually use, plus contacts
-- excluding soft-deleted mail. Partial mailbox indexes stay aligned with
-- api/emails.js folder predicates (inlined so the planner can match them).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS messages_from_address_trgm_idx
  ON messages USING gin (from_address gin_trgm_ops);

CREATE INDEX IF NOT EXISTS messages_from_name_trgm_idx
  ON messages USING gin (from_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS messages_starred_list_idx
  ON messages (user_id, sent_at DESC, id DESC)
  WHERE NOT is_deleted AND is_starred;

CREATE INDEX IF NOT EXISTS messages_snoozed_list_idx
  ON messages (user_id, sent_at DESC, id DESC)
  WHERE NOT is_deleted AND NOT is_archived AND NOT is_sent AND scheduled_for IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_folder_idx
  ON public.documents (folder_id)
  WHERE folder_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS document_folders_parent_idx
  ON public.document_folders (parent_id)
  WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_tags_gin_idx
  ON public.documents USING gin (tags);

CREATE OR REPLACE VIEW contacts AS
WITH sent_to AS (
  SELECT DISTINCT m.user_id, addr.address
  FROM messages m
  CROSS JOIN LATERAL jsonb_array_elements(
    coalesce(m.recipients->'to', '[]'::jsonb)
    || coalesce(m.recipients->'cc', '[]'::jsonb)
    || coalesce(m.recipients->'bcc', '[]'::jsonb)
  ) AS rcpt
  CROSS JOIN LATERAL (
    SELECT lower(btrim(
      CASE WHEN jsonb_typeof(rcpt) = 'string' THEN rcpt #>> '{}'
           ELSE rcpt->>'address' END
    )) AS address
  ) AS addr
  WHERE m.is_sent
    AND NOT m.is_deleted
    AND nullif(addr.address, '') IS NOT NULL
),
received_from AS (
  SELECT
    m.user_id,
    lower(btrim(m.from_address)) AS address,
    (array_agg(m.from_name) FILTER (WHERE nullif(btrim(m.from_name), '') IS NOT NULL))[1] AS name
  FROM messages m
  WHERE NOT m.is_sent
    AND NOT m.is_deleted
    AND nullif(btrim(m.from_address), '') IS NOT NULL
  GROUP BY m.user_id, lower(btrim(m.from_address))
),
all_contacts AS (
  SELECT user_id, address, NULL::text AS name FROM sent_to
  UNION ALL
  SELECT user_id, address, name FROM received_from
)
SELECT
  a.user_id,
  a.address,
  (array_agg(a.name) FILTER (WHERE a.name IS NOT NULL))[1] AS name
FROM all_contacts a
JOIN users u ON u.id = a.user_id
WHERE a.address <> lower(u.email)
GROUP BY a.user_id, a.address;

REVOKE ALL PRIVILEGES ON TABLE public.contacts FROM anon, authenticated;

COMMIT;
