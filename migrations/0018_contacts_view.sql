-- 0018_contacts_view.sql
-- Contacts for compose auto-suggest: the unique email addresses the user has
-- BOTH sent mail to and received mail from (two-way correspondents). Derived
-- from messages as a VIEW rather than a maintained table, so it is always
-- current with no backfill/trigger upkeep — the set is cheap to recompute at
-- personal-mailbox scale.
--
--   sent_to       = every recipient (to/cc/bcc) address on the user's sent mail
--   received_from = every sender address on the user's received mail
--   contacts      = the intersection, one row per (user, address)
--
-- Addresses are lowercased so the intersection and uniqueness are
-- case-insensitive. name is a display name taken from received mail (sent
-- recipients are stored without names).
--
-- recipients is polymorphic on two axes, so it is normalized before use:
--   * the whole value may be a proper jsonb object, OR a jsonb *string* holding
--     JSON text (some sent rows were stored double-encoded — the app re-parses
--     these in code too, see summarize.js), and
--   * each to/cc/bcc element may be an object {name,address} (app-sent mail) or
--     a plain address string (ingest-worker mail).
-- norm.recip unwraps a double-encoded value; the per-element CASE handles both
-- element shapes.

BEGIN;

CREATE VIEW contacts AS
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
)
SELECT rf.user_id, rf.address, rf.name
FROM received_from rf
JOIN sent_to st ON st.user_id = rf.user_id AND st.address = rf.address;

COMMIT;
