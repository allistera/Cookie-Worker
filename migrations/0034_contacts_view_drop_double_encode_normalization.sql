-- 0034_contacts_view_drop_double_encode_normalization.sql
-- 0018/0019's contacts view normalized messages.recipients against two axes:
-- the whole value could be double-encoded (a jsonb *string* holding JSON
-- text instead of a proper object), and each to/cc/bcc element could be a
-- plain address string or an {name,address} object. The double-encoding was
-- a bug in mail-app-ingest's storeEmail, now fixed at the source (Cookie-Worker
-- store.js uses tx.json() instead of JSON.stringify()::jsonb), and every
-- historical row has been backfilled to a proper jsonb object. The whole-value
-- CASE WHEN is dead weight now; the per-element CASE WHEN stays; it handles a
-- real, still-current shape difference between app-composed and
-- ingest-worker-stored recipients, not the double-encoding bug.

BEGIN;

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
    AND nullif(addr.address, '') IS NOT NULL
),
received_from AS (
  SELECT
    m.user_id,
    lower(btrim(m.from_address)) AS address,
    (array_agg(m.from_name) FILTER (WHERE nullif(btrim(m.from_name), '') IS NOT NULL))[1] AS name
  FROM messages m
  WHERE NOT m.is_sent
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
WHERE a.address <> lower(u.email)   -- don't suggest the user their own address
GROUP BY a.user_id, a.address;

COMMIT;
