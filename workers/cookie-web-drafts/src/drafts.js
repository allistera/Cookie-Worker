// Server-side composer drafts. Autosave rewrites the same row every few
// seconds while someone types, so every write is a whole-draft replace rather
// than a field-level patch: the composer is the authority on its own contents,
// and a partial merge across two open tabs would interleave into nonsense.
//
// Drafts deliberately do not live in `messages` (see migration 0061).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors cookie-web-send's outbound ceilings exactly, so a draft can never
// grow into something the send path would refuse to deliver. The recipient
// bound is its MAX_RECIPIENTS_FIELD_CHARS (20 addresses x 512); the aggregate
// is its MAX_OUTBOUND_TOTAL_BYTES, which the per-field caps alone do not
// imply — 100KB of text plus 200KB of html clears both and still cannot send.
const MAX_TO_BYTES = 10_240;
const MAX_SUBJECT_BYTES = 998;
const MAX_TEXT_BYTES = 100_000;
const MAX_HTML_BYTES = 200_000;
const MAX_TOTAL_BYTES = 256_000;
const MAX_ATTACHMENTS = 20;
// Autosave means a runaway client could otherwise mint rows forever.
export const MAX_DRAFTS_PER_USER = 200;

const encoder = new TextEncoder();

/** @param {unknown} value */
function byteLength(value) {
  return encoder.encode(String(value ?? '')).byteLength;
}

/**
 * Normalises one autosave payload. Returns `null` when the client sent
 * something the send API would later reject, so a draft can never become
 * un-sendable by being saved.
 *
 * @param {any} body
 */
export function parseDraftBody(body) {
  if (!body || typeof body !== 'object') return null;

  const toAddresses = String(body.to ?? '');
  const subject = String(body.subject ?? '');
  const text = String(body.text ?? '');
  const html = body.html === null || body.html === undefined ? null : String(body.html);

  const subjectBytes = byteLength(subject);
  const textBytes = byteLength(text);
  const htmlBytes = html === null ? 0 : byteLength(html);
  if (
    byteLength(toAddresses) > MAX_TO_BYTES ||
    subjectBytes > MAX_SUBJECT_BYTES ||
    textBytes > MAX_TEXT_BYTES ||
    htmlBytes > MAX_HTML_BYTES ||
    subjectBytes + textBytes + htmlBytes > MAX_TOTAL_BYTES
  ) {
    return null;
  }

  const replyToMessageId = UUID_RE.test(body.replyToMessageId)
    ? String(body.replyToMessageId)
    : null;

  const followUpAt =
    body.followUpAt === null || body.followUpAt === undefined ? null : new Date(body.followUpAt);
  if (followUpAt && Number.isNaN(followUpAt.getTime())) return null;

  const rawAttachments = body.attachmentIds === undefined ? [] : body.attachmentIds;
  if (!Array.isArray(rawAttachments) || rawAttachments.length > MAX_ATTACHMENTS) return null;
  const attachmentIds = rawAttachments.map((id) => String(id));
  if (
    attachmentIds.some((id) => !UUID_RE.test(id)) ||
    new Set(attachmentIds).size !== attachmentIds.length
  ) {
    return null;
  }

  return {
    toAddresses,
    subject,
    text,
    html,
    replyToMessageId,
    followUpAt: followUpAt ? followUpAt.toISOString() : null,
    attachmentIds,
  };
}

// A draft with nothing in it is not worth a row — the composer opens one on
// every "Compose" click, and most are closed untouched.
export function isEmptyDraft(draft) {
  return (
    !draft.toAddresses.trim() &&
    !draft.subject.trim() &&
    !draft.text.trim() &&
    draft.attachmentIds.length === 0
  );
}

// Attachments are stored by the same two-source rule as scheduled sends: a
// forwarded inbound attachment, or a composer upload. Ownership is re-checked
// here rather than trusted, so a draft cannot become a way to reference
// someone else's file by id.
async function replaceDraftAttachments(sql, userId, draftId, attachmentIds) {
  await sql`DELETE FROM draft_attachments WHERE draft_id = ${draftId}`;
  if (attachmentIds.length === 0) return;

  const owned = await sql`
    SELECT a.id, 'inbound' AS source
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE a.id = ANY(${attachmentIds}::uuid[])
      AND m.user_id = ${userId}
      AND NOT m.is_deleted
    UNION ALL
    SELECT o.id, 'upload' AS source
    FROM outbound_attachments o
    WHERE o.id = ANY(${attachmentIds}::uuid[])
      AND o.user_id = ${userId}
  `;
  const sourceById = new Map(owned.map((row) => [String(row.id), row.source]));

  // Unowned ids are dropped rather than failing the save: losing an
  // attachment reference must not cost someone the text they just typed.
  let position = 0;
  for (const id of attachmentIds) {
    const source = sourceById.get(id);
    if (!source) continue;
    await sql`
      INSERT INTO draft_attachments
        (draft_id, attachment_id, outbound_attachment_id, position)
      VALUES (${draftId},
              ${source === 'upload' ? null : id}::uuid,
              ${source === 'upload' ? id : null}::uuid,
              ${position})
    `;
    position += 1;
  }
}

/**
 * GET /drafts — newest first. The list is small and bounded by
 * MAX_DRAFTS_PER_USER, so it is returned in one page.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {boolean} [summary]
 */
export async function listDrafts(sql, userId, summary = false) {
  if (summary) {
    const drafts = await sql`
      SELECT d.id, left(d.to_addresses, 512) AS "to", d.subject,
        left(d.body_text, 141) AS preview, d.reply_to_message_id AS "replyToMessageId",
        d.updated_at AS "updatedAt", d.is_ai_generated AS "isAiGenerated", true AS "isSummary",
        (SELECT count(*)::int FROM draft_attachments da WHERE da.draft_id = d.id) AS "attachmentCount"
      FROM drafts d WHERE d.user_id = ${userId}
      ORDER BY d.updated_at DESC LIMIT ${MAX_DRAFTS_PER_USER}
    `;
    return Response.json({ drafts });
  }
  const drafts = await sql`
    SELECT
      d.id, d.to_addresses AS "to", d.subject, d.body_text AS "text",
      d.body_html AS "html", d.reply_to_message_id AS "replyToMessageId",
      d.follow_up_at AS "followUpAt", d.updated_at AS "updatedAt", d.is_ai_generated AS "isAiGenerated",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', COALESCE(a.id, oa.id),
          'filename', COALESCE(a.filename, oa.filename),
          'content_type', COALESCE(a.content_type, oa.content_type),
          'size_bytes', COALESCE(a.size_bytes, oa.size_bytes),
          'source', CASE WHEN oa.id IS NOT NULL THEN 'upload' ELSE 'inbound' END
        ) ORDER BY da.position)
        FROM draft_attachments da
        LEFT JOIN attachments a ON a.id = da.attachment_id
        LEFT JOIN outbound_attachments oa ON oa.id = da.outbound_attachment_id
        WHERE da.draft_id = d.id
      ), '[]'::jsonb) AS attachments
    FROM drafts d
    WHERE d.user_id = ${userId}
    ORDER BY d.updated_at DESC
  `;
  return Response.json({ drafts });
}

/**
 * GET /drafts/:id — one draft, for reopening it in the composer.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 */
export async function getDraft(sql, userId, id) {
  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'A valid draft id is required' }, { status: 400 });
  }
  const [draft] = await sql`
    SELECT
      d.id, d.to_addresses AS "to", d.subject, d.body_text AS "text",
      d.body_html AS "html", d.reply_to_message_id AS "replyToMessageId",
      d.follow_up_at AS "followUpAt", d.updated_at AS "updatedAt", d.is_ai_generated AS "isAiGenerated",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', COALESCE(a.id, oa.id),
          'filename', COALESCE(a.filename, oa.filename),
          'content_type', COALESCE(a.content_type, oa.content_type),
          'size_bytes', COALESCE(a.size_bytes, oa.size_bytes),
          'source', CASE WHEN oa.id IS NOT NULL THEN 'upload' ELSE 'inbound' END
        ) ORDER BY da.position)
        FROM draft_attachments da
        LEFT JOIN attachments a ON a.id = da.attachment_id
        LEFT JOIN outbound_attachments oa ON oa.id = da.outbound_attachment_id
        WHERE da.draft_id = d.id
      ), '[]'::jsonb) AS attachments
    FROM drafts d
    WHERE d.id = ${id} AND d.user_id = ${userId}
  `;
  if (!draft) return Response.json({ error: 'Draft not found' }, { status: 404 });
  return Response.json({ draft });
}

/**
 * POST /drafts — first autosave of a composing session. Returns the id the
 * client then PATCHes for the rest of the session.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function createDraft(sql, userId, body) {
  const parsed = parseDraftBody(body);
  if (!parsed) return Response.json({ error: 'Invalid draft' }, { status: 400 });
  if (isEmptyDraft(parsed)) {
    return Response.json({ error: 'Draft is empty' }, { status: 400 });
  }

  return sql.begin(async (tx) => {
    // Bounded the same way scheduled sends are: count and insert under a
    // per-user advisory lock, since READ COMMITTED alone lets two concurrent
    // autosaves both see room for the last slot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}::text)::bigint)`;
    const [row] = await tx`
      INSERT INTO drafts
        (user_id, to_addresses, subject, body_text, body_html, reply_to_message_id, follow_up_at)
      SELECT ${userId}, ${parsed.toAddresses}, ${parsed.subject}, ${parsed.text},
             ${parsed.html}, ${parsed.replyToMessageId}::uuid,
             ${parsed.followUpAt}::timestamptz
      WHERE (SELECT count(*) FROM drafts d WHERE d.user_id = ${userId}) < ${MAX_DRAFTS_PER_USER}
      RETURNING id, updated_at AS "updatedAt"
    `;
    if (!row) {
      return Response.json({ error: 'Too many saved drafts' }, { status: 429 });
    }
    await replaceDraftAttachments(tx, userId, row.id, parsed.attachmentIds);
    return Response.json({ draft: { id: row.id, updatedAt: row.updatedAt } }, { status: 201 });
  });
}

/**
 * PATCH /drafts/:id — a later autosave. The whole draft is replaced; see the
 * note at the top of this file on why this is not a field-level merge.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @param {any} body
 */
export async function updateDraft(sql, userId, id, body) {
  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'A valid draft id is required' }, { status: 400 });
  }
  const parsed = parseDraftBody(body);
  if (!parsed) return Response.json({ error: 'Invalid draft' }, { status: 400 });

  // Emptying a draft is how someone discards one: clearing the composer and
  // closing it should not leave a blank row in the Drafts list.
  if (isEmptyDraft(parsed)) return deleteDraft(sql, userId, id);

  return sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE drafts
      SET to_addresses = ${parsed.toAddresses},
          subject = ${parsed.subject},
          body_text = ${parsed.text},
          body_html = ${parsed.html},
          reply_to_message_id = ${parsed.replyToMessageId}::uuid,
          follow_up_at = ${parsed.followUpAt}::timestamptz,
          updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id, updated_at AS "updatedAt"
    `;
    if (!row) return Response.json({ error: 'Draft not found' }, { status: 404 });
    await replaceDraftAttachments(tx, userId, row.id, parsed.attachmentIds);
    return Response.json({ draft: { id: row.id, updatedAt: row.updatedAt } });
  });
}

/**
 * DELETE /drafts/:id — the draft was sent, or discarded. Attachment rows go
 * with it via ON DELETE CASCADE; the uploads themselves are reclaimed by
 * Cookie-Web's orphaned-upload sweep once nothing references them.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 */
export async function deleteDraft(sql, userId, id) {
  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'A valid draft id is required' }, { status: 400 });
  }
  const [row] = await sql`
    DELETE FROM drafts WHERE id = ${id} AND user_id = ${userId} RETURNING id
  `;
  if (!row) return Response.json({ error: 'Draft not found' }, { status: 404 });
  return new Response(null, { status: 204 });
}
