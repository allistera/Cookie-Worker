-- 0083_outbound_attachments_unique.sql
-- One composer upload row per (user, blob). A retried registration used to
-- insert a second row for the same blob_url, and removing either copy from the
-- composer could then delete bytes the other row (or a draft / scheduled send
-- pointing at it) still needed. Registration now upserts on this key.
--
-- Existing duplicates are folded into the oldest row of each group: references
-- from scheduled_send_attachments and draft_attachments are repointed at that
-- keeper first, so the ON DELETE CASCADE on the duplicate rows removes nothing
-- a pending send or draft still uses. The blob itself is untouched — the
-- keeper still owns it.

BEGIN;

-- Block concurrent registrations so no new duplicate lands between the
-- dedupe and the index build, and block draft saves / scheduled sends so no
-- new reference to a duplicate appears after the repoint and is then removed
-- by the cascade. Reads stay available.
LOCK TABLE public.outbound_attachments,
           public.draft_attachments,
           public.scheduled_send_attachments
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE outbound_attachment_dupes ON COMMIT DROP AS
SELECT id AS dup_id, keep_id
FROM (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY user_id, blob_url ORDER BY created_at, id
         ) AS keep_id
  FROM public.outbound_attachments
) ranked
WHERE id <> keep_id;

-- A send or draft can hold two duplicates of the same upload (or a duplicate
-- and its keeper). Repointing both would violate the per-source unique index,
-- so drop the redundant reference first, preferring to keep the one that
-- already points at the keeper.
DELETE FROM public.scheduled_send_attachments s
USING (
  SELECT s2.ctid AS row_ctid,
         row_number() OVER (
           PARTITION BY s2.scheduled_send_id, coalesce(d.keep_id, s2.outbound_attachment_id)
           ORDER BY (d.dup_id IS NULL) DESC
         ) AS rn
  FROM public.scheduled_send_attachments s2
  LEFT JOIN outbound_attachment_dupes d ON d.dup_id = s2.outbound_attachment_id
  WHERE s2.outbound_attachment_id IS NOT NULL
) ranked
WHERE s.ctid = ranked.row_ctid AND ranked.rn > 1;

UPDATE public.scheduled_send_attachments s
SET outbound_attachment_id = d.keep_id
FROM outbound_attachment_dupes d
WHERE s.outbound_attachment_id = d.dup_id;

DELETE FROM public.draft_attachments da
USING (
  SELECT da2.ctid AS row_ctid,
         row_number() OVER (
           PARTITION BY da2.draft_id, coalesce(d.keep_id, da2.outbound_attachment_id)
           ORDER BY (d.dup_id IS NULL) DESC, da2.position
         ) AS rn
  FROM public.draft_attachments da2
  LEFT JOIN outbound_attachment_dupes d ON d.dup_id = da2.outbound_attachment_id
  WHERE da2.outbound_attachment_id IS NOT NULL
) ranked
WHERE da.ctid = ranked.row_ctid AND ranked.rn > 1;

UPDATE public.draft_attachments da
SET outbound_attachment_id = d.keep_id
FROM outbound_attachment_dupes d
WHERE da.outbound_attachment_id = d.dup_id;

-- Nothing references the duplicates any more, so the cascade is a no-op.
DELETE FROM public.outbound_attachments oa
USING outbound_attachment_dupes d
WHERE oa.id = d.dup_id;

-- Also the ON CONFLICT arbiter for registration in api/_lib/outboundUploads.js.
CREATE UNIQUE INDEX outbound_attachments_user_blob_key
  ON public.outbound_attachments (user_id, blob_url);

COMMIT;
