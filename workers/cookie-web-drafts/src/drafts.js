// Server-side composer drafts. Autosave rewrites the same row every few
// seconds while someone types, so every write is a whole-draft replace rather
// than a field-level patch: the composer is the authority on its own contents,
// and a partial merge across two open tabs would interleave into nonsense.
//
// Drafts deliberately do not live in `messages` (see migration 0061).

import { validId } from '../../../shared/pagination.js';

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

  const replyToMessageId = validId(body.replyToMessageId) ? String(body.replyToMessageId) : null;

  const followUpAt =
    body.followUpAt === null || body.followUpAt === undefined ? null : new Date(body.followUpAt);
  if (followUpAt && Number.isNaN(followUpAt.getTime())) return null;

  const rawAttachments = body.attachmentIds === undefined ? [] : body.attachmentIds;
  if (!Array.isArray(rawAttachments) || rawAttachments.length > MAX_ATTACHMENTS) return null;
  const attachmentIds = rawAttachments.map((id) => String(id));
  if (
    attachmentIds.some((id) => !validId(id)) ||
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
//
// `storedIds` is the draft's current list in position order, when the caller
// already has it. Autosave fires every few seconds while someone types and
// the attachment list almost never changes between saves, so an unchanged
// list is left alone rather than deleted and written back.
/**
 * @param {import('postgres').Sql | import('postgres').TransactionSql} sql
 * @param {string} userId
 * @param {string} draftId
 * @param {string[]} attachmentIds
 * @param {string[] | null} [storedIds]
 */
async function replaceDraftAttachments(sql, userId, draftId, attachmentIds, storedIds = null) {
  if (storedIds && sameIds(storedIds, attachmentIds)) return;
  if (storedIds === null || storedIds.length > 0) {
    await sql`DELETE FROM draft_attachments WHERE draft_id = ${draftId}`;
  }
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
  const sourceById = new Map(owned.map((row) => [String(row.id).toLowerCase(), row.source]));

  // Unowned ids are dropped rather than failing the save: losing an
  // attachment reference must not cost someone the text they just typed.
  const ids = [];
  const sources = [];
  for (const id of attachmentIds) {
    const source = sourceById.get(id.toLowerCase());
    if (!source) continue;
    ids.push(id);
    sources.push(source);
  }
  if (ids.length === 0) return;
  // One statement for the whole list; ORDINALITY keeps the composer's order.
  await sql`
    INSERT INTO draft_attachments
      (draft_id, attachment_id, outbound_attachment_id, position)
    SELECT ${draftId},
           CASE WHEN picked.source = 'upload' THEN NULL ELSE picked.id END,
           CASE WHEN picked.source = 'upload' THEN picked.id END,
           (picked.ord - 1)::smallint
    FROM unnest(${ids}::uuid[], ${sources}::text[]) WITH ORDINALITY AS picked(id, source, ord)
  `;
}

/**
 * @param {string[]} stored
 * @param {string[]} requested
 */
function sameIds(stored, requested) {
  return (
    stored.length === requested.length &&
    stored.every((id, index) => String(id).toLowerCase() === requested[index].toLowerCase())
  );
}

// `updated_at` is compared at the millisecond precision the client was given:
// postgres.js hands timestamptz back as a JS Date, which keeps milliseconds
// and drops the microseconds Postgres stores. Parsing through Date cuts a
// more precise client value the same way, and normalises its offset.
/**
 * @param {unknown} value
 * @returns {{expected: string | null, invalid?: undefined} | {invalid: true, expected?: undefined}}
 */
export function parseExpectedUpdatedAt(value) {
  if (value === undefined || value === null) return { expected: null };
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return { invalid: true };
  return { expected: new Date(value).toISOString() };
}

/**
 * The full draft as GET /drafts/:id returns it, or undefined.
 *
 * @param {import('postgres').Sql | import('postgres').TransactionSql} sql
 * @param {string} userId
 * @param {string} id
 */
async function fetchDraft(sql, userId, id) {
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
  return draft;
}

/**
 * A conditional write matched no row: either the draft is gone (404) or
 * another tab or device saved it since this client last read it (409, with
 * the current draft so the client can reconcile without another request).
 *
 * @param {import('postgres').Sql | import('postgres').TransactionSql} sql
 * @param {string} userId
 * @param {string} id
 */
async function missedWriteResponse(sql, userId, id) {
  const current = await fetchDraft(sql, userId, id);
  if (!current) return Response.json({ error: 'Draft not found' }, { status: 404 });
  return Response.json({ error: 'Draft changed elsewhere', draft: current }, { status: 409 });
}

/**
 * GET /drafts — newest first, as summaries only: the list never needs a
 * draft's full bodies, and 200 of them at up to ~300KB each is too much to
 * return in one response. The composer reopens a draft through GET
 * /drafts/:id. The list is bounded by MAX_DRAFTS_PER_USER, so it is returned
 * in one page.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function listDrafts(sql, userId) {
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

/**
 * GET /drafts/:id — one draft, for reopening it in the composer.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 */
export async function getDraft(sql, userId, id) {
  if (!validId(id)) {
    return Response.json({ error: 'A valid draft id is required' }, { status: 400 });
  }
  const draft = await fetchDraft(sql, userId, id);
  if (!draft) return Response.json({ error: 'Draft not found' }, { status: 404 });
  return Response.json({ draft });
}

/**
 * POST /drafts — first autosave of a composing session. Returns the id the
 * client then PATCHes for the rest of the session, and the `updatedAt` it
 * sends back as `expectedUpdatedAt`.
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
             ${parsed.html},
             -- reply_to_message_id references messages (migration 0061), so a
             -- purged or foreign id is resolved to NULL here rather than
             -- failing the FK and costing the whole autosave.
             (SELECT m.id FROM messages m
              WHERE m.id = ${parsed.replyToMessageId}::uuid AND m.user_id = ${userId}),
             ${parsed.followUpAt}::timestamptz
      WHERE (SELECT count(*) FROM drafts d WHERE d.user_id = ${userId}) < ${MAX_DRAFTS_PER_USER}
      RETURNING id, updated_at AS "updatedAt"
    `;
    if (!row) {
      return Response.json({ error: 'Too many saved drafts' }, { status: 429 });
    }
    await replaceDraftAttachments(tx, userId, row.id, parsed.attachmentIds, []);
    return Response.json({ draft: { id: row.id, updatedAt: row.updatedAt } }, { status: 201 });
  });
}

/**
 * PATCH /drafts/:id — a later autosave. The whole draft is replaced; see the
 * note at the top of this file on why this is not a field-level merge.
 *
 * Optional `expectedUpdatedAt` (the `updatedAt` this client last received)
 * makes the write conditional: when the stored draft has moved on since,
 * nothing is written and the answer is 409 {error: 'Draft changed
 * elsewhere', draft} with the current draft in GET /drafts/:id's shape.
 * Without it the write is unconditional, as older clients expect.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @param {any} body
 */
export async function updateDraft(sql, userId, id, body) {
  if (!validId(id)) {
    return Response.json({ error: 'A valid draft id is required' }, { status: 400 });
  }
  const parsed = parseDraftBody(body);
  if (!parsed) return Response.json({ error: 'Invalid draft' }, { status: 400 });
  const version = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (version.invalid) {
    return Response.json({ error: 'expectedUpdatedAt must be an ISO timestamp' }, { status: 400 });
  }
  const expected = version.expected ?? null;

  // Emptying a draft is how someone discards one: clearing the composer and
  // closing it should not leave a blank row in the Drafts list.
  if (isEmptyDraft(parsed)) {
    if (!expected) return deleteDraft(sql, userId, id);
    // A stale tab clearing its composer must not discard what another one
    // has since written, so the delete is conditional too.
    const [deleted] = await sql`
      DELETE FROM drafts
      WHERE id = ${id} AND user_id = ${userId}
        AND date_trunc('milliseconds', updated_at) = ${expected}::timestamptz
      RETURNING id
    `;
    if (!deleted) return missedWriteResponse(sql, userId, id);
    return new Response(null, { status: 204 });
  }

  return sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE drafts
      SET to_addresses = ${parsed.toAddresses},
          subject = ${parsed.subject},
          body_text = ${parsed.text},
          body_html = ${parsed.html},
          -- Resolved in-statement for the FK, as in createDraft.
          reply_to_message_id = (SELECT m.id FROM messages m
                                 WHERE m.id = ${parsed.replyToMessageId}::uuid
                                   AND m.user_id = ${userId}),
          follow_up_at = ${parsed.followUpAt}::timestamptz,
          updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}
        -- The version check, when the client sent one. Both sides are cut to
        -- the millisecond precision the client was handed (see
        -- parseExpectedUpdatedAt).
        AND (${expected}::timestamptz IS NULL
             OR date_trunc('milliseconds', updated_at) = ${expected}::timestamptz)
      RETURNING id, updated_at AS "updatedAt",
        -- The attachment list as it stood before this save (the subquery
        -- reads the statement's snapshot), so an unchanged one is skipped.
        COALESCE((
          SELECT jsonb_agg(COALESCE(da.attachment_id, da.outbound_attachment_id)::text
                           ORDER BY da.position)
          FROM draft_attachments da WHERE da.draft_id = drafts.id
        ), '[]'::jsonb) AS "attachmentIds"
    `;
    if (!row) return missedWriteResponse(tx, userId, id);
    await replaceDraftAttachments(
      tx,
      userId,
      row.id,
      parsed.attachmentIds,
      Array.isArray(row.attachmentIds) ? row.attachmentIds : null,
    );
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
  if (!validId(id)) {
    return Response.json({ error: 'A valid draft id is required' }, { status: 400 });
  }
  const [row] = await sql`
    DELETE FROM drafts WHERE id = ${id} AND user_id = ${userId} RETURNING id
  `;
  if (!row) return Response.json({ error: 'Draft not found' }, { status: 404 });
  return new Response(null, { status: 204 });
}
