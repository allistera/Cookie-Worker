-- 0019_contacts_union.sql
-- Broaden the contacts view (0018) from the strict intersection (addresses the
-- user both sent to AND received from) to the UNION: every address that already
-- appears in the mailbox as a received sender OR a sent recipient. This
-- immediately populates compose auto-suggest from existing mail instead of
-- waiting for two-way correspondence to accumulate.
--
-- Still derived (no maintained table), still one row per (user, address) with a
-- display name preferred from received mail, and the user's own login address
-- is excluded so they aren't suggested to themselves. recipients normalization
-- is unchanged from 0018 (handles double-encoded values and object/string
-- element shapes).

BEGIN;

CREATE OR REPLACE VIEW contacts AS
WITH sent_to AS (
  SELECT DISTINCT m.user_id, addr.address
  FROM messages m
  CROSS JOIN LATERAL (
    SELECT CASE WHEN jsonb_typeof(m.recipients) = 'string'
                THEN (m.recipients #>> '{}')::jsonb
                ELSE m.recipients END AS recip
  ) AS norm
  CROSS JOIN LATERAL jsonb_array_elements(
    coalesce(norm.recip->'to', '[]'::jsonb)
    || coalesce(norm.recip->'cc', '[]'::jsonb)
    || coalesce(norm.recip->'bcc', '[]'::jsonb)
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
