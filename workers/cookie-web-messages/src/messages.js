import { createTimings } from '../../../shared/performance.js';
// Ported from Cookie-Web's api/messages.js. Behaviorally identical (same
// queries, same validation, same response shapes/status codes) — only the
// (req, res) mutation style becomes returning a Response, and external
// dependencies (Blob signed URLs, the SSRF-safe unsubscribe POST, Resend)
// are passed in rather than pulled from a services object, so each handler
// stays a plain, testable function.

import { allowRequest } from '../../../shared/rate-limit.js';
import { extractCalendarInvite, isCalendarAttachment } from './calendarInvite.js';
import { isSafeUnsubscribeUrl, parseListUnsubscribe } from './unsubscribe.js';
import { isTransientDbError } from '../../../shared/transient-db.js';
import { validId } from '../../../shared/pagination.js';

const SIGNED_URL_TTL_MS = 5 * 60 * 1000;
// Unsubscribe actions can perform outbound POSTs or send email, so cap the
// rate per user to prevent abuse of provider quotas.
const UNSUBSCRIBE_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/**
 * GET /messages?id=<uuid> — the full body of a single message owned by the
 * authenticated user, fetched on demand when the reader opens (body_html is
 * deliberately excluded from the /messages list payload as it can be large
 * and untrusted). A thread summary is returned only when it includes the
 * newest live message, so the reader never restores stale generated text.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} id
 * @param {string} userId
 */
export function fetchOwnedMessageBody(sql, id, userId) {
  return sql`
    SELECT m.id, m.thread_id, m.body_html, m.body_text, m.headers, m.screening_status,
           CASE WHEN t.ai_summary_message_id = latest.id
                THEN t.ai_summary ELSE NULL END AS thread_summary,
           latest.id AS thread_latest_message_id,
           t.is_muted AS thread_muted
    FROM messages m
    JOIN threads t ON t.id = m.thread_id AND t.user_id = m.user_id
    LEFT JOIN LATERAL (
      SELECT newest.id
      FROM messages newest
      WHERE newest.thread_id = m.thread_id AND newest.user_id = m.user_id
        AND NOT newest.is_deleted
      ORDER BY newest.sent_at DESC, newest.id DESC
      LIMIT 1
    ) latest ON true
    WHERE m.id = ${id} AND m.user_id = ${userId} AND NOT m.is_deleted
  `;
}

/**
 * The other messages in this message's conversation (thread_id), oldest
 * first, for the reader's collapsed conversation history. Only the summary
 * fields are selected — body_html/blob URLs are deliberately left out, same
 * as the inbox list, since older thread messages render as plain text.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} threadId
 * @param {string} userId
 */
export const MAX_THREAD_MESSAGES = 50;

export function fetchThreadMessages(sql, threadId, userId) {
  return sql`
    SELECT m.id, m.from_name, m.from_address, m.snippet, m.sent_at, m.is_sent
    FROM messages m
    WHERE m.thread_id = ${threadId} AND m.user_id = ${userId}
      AND NOT m.is_deleted
      AND m.screening_status = 'allowed'
    ORDER BY m.sent_at ASC
    LIMIT ${MAX_THREAD_MESSAGES}
  `;
}

/**
 * A message's attachments, ordered by filename. The private Blob URL never
 * leaves the server; the client only learns whether the ownership-checked
 * attachment download endpoint can issue a short-lived URL. messageId
 * ownership is already verified by the caller before this runs.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} messageId
 */
export function fetchMessageAttachments(sql, messageId) {
  return sql`
    SELECT id, filename, content_type, size_bytes, blob_url,
      (blob_url IS NOT NULL) AS downloadable
    FROM attachments
    WHERE message_id = ${messageId}
    ORDER BY filename
  `;
}

/**
 * @typedef {{
 *   readBlob?: (url: string) => Promise<{stream: ReadableStream<Uint8Array> | null} | null>,
 *   deferCalendar?: boolean,
 * }} CalendarInviteDeps
 */

/**
 * @param {import('postgres').Sql} sql
 * @param {string} id
 * @param {string} userId
 */
export function fetchOwnedAttachment(sql, id, userId) {
  return sql`
    SELECT a.filename, a.content_type, a.blob_url
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE a.id = ${id} AND m.user_id = ${userId}
  `;
}

/** @param {string} blobUrl */
export function privateBlobPathname(blobUrl) {
  const url = new URL(blobUrl);
  if (!url.hostname.endsWith('.private.blob.vercel-storage.com')) {
    throw new Error('Attachment does not reference private Blob storage');
  }
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

/** @param {Response} response */
function noStore(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * GET /messages/attachment?id=<uuid>
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string | null} id
 * @param {{
 *   issueSignedToken: typeof import('@vercel/blob').issueSignedToken,
 *   presignUrl: typeof import('@vercel/blob').presignUrl,
 *   getDownloadUrl: typeof import('@vercel/blob').getDownloadUrl,
 *   token: string | undefined,
 * }} blob
 */
export async function getAttachment(sql, userId, id, blob) {
  if (!id || !validId(id)) {
    return noStore(Response.json({ error: 'A valid attachment id is required' }, { status: 400 }));
  }

  try {
    const rows = await fetchOwnedAttachment(sql, id, userId);
    const attachment = rows[0];
    if (!attachment?.blob_url) {
      return noStore(Response.json({ error: 'Attachment is not available' }, { status: 404 }));
    }

    const pathname = privateBlobPathname(attachment.blob_url);
    const validUntil = Date.now() + SIGNED_URL_TTL_MS;
    const signedToken = await blob.issueSignedToken({
      pathname,
      operations: ['get'],
      validUntil,
      token: blob.token,
    });
    const { presignedUrl } = await blob.presignUrl(signedToken, {
      access: 'private',
      operation: 'get',
      pathname,
      validUntil,
    });

    return noStore(
      Response.json({
        url: blob.getDownloadUrl(presignedUrl),
        filename: attachment.filename || 'attachment',
        contentType: attachment.content_type || 'application/octet-stream',
      }),
    );
  } catch (error) {
    // A dropped connection is the worker's to retry, not this handler's to
    // report.
    if (isTransientDbError(error)) throw error;
    console.log(
      JSON.stringify({
        event: 'attachment_download_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return noStore(
      Response.json({ error: 'Failed to prepare attachment download' }, { status: 500 }),
    );
  }
}

/**
 * 404 for a message that is not the caller's (or does not exist), 400 for a
 * malformed id.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string | null} id
 * @param {CalendarInviteDeps} [deps]
 */
export async function getMessage(sql, userId, id, deps = {}) {
  if (!id || !validId(id)) {
    return Response.json({ error: 'A valid message id is required' }, { status: 400 });
  }

  const timing = createTimings();
  const rows = await timing.run('body', () => fetchOwnedMessageBody(sql, id, userId));
  if (rows.length === 0) {
    return Response.json({ error: 'Message not found' }, { status: 404 });
  }
  // Never return the raw sender-controlled headers to the client; expose only
  // the parsed, safe unsubscribe summary.
  const { headers, thread_id, ...rest } = rows[0];
  const [thread, attachments] = await Promise.all([
    thread_id ? timing.run('thread', () => fetchThreadMessages(sql, thread_id, userId)) : [],
    timing.run('attachments', () => fetchMessageAttachments(sql, id)),
  ]);
  const calendar_invite = deps.deferCalendar
    ? null
    : await timing.run('invite', () => extractCalendarInvite(attachments, deps.readBlob));
  return timing.response(
    Response.json({
      ...rest,
      thread_id,
      unsubscribe: parseListUnsubscribe(headers),
      thread,
      calendar_invite,
      ...(deps.deferCalendar
        ? { calendar_invite_pending: attachments.some(isCalendarAttachment) }
        : {}),
      attachments: attachments.map(({ blob_url: _blobUrl, ...attachment }) => attachment),
    }),
  );
}

/**
 * Invitation metadata is optional reader enrichment. Check ownership before
 * touching attachments; this endpoint never loads the message's large body.
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string | null} id
 * @param {CalendarInviteDeps} [deps]
 */
export async function getCalendarInvite(sql, userId, id, deps = {}) {
  if (!id || !validId(id))
    return Response.json({ error: 'A valid message id is required' }, { status: 400 });
  const [owned] =
    await sql`SELECT id FROM messages WHERE id = ${id} AND user_id = ${userId} AND NOT is_deleted`;
  if (!owned) return Response.json({ error: 'Message not found' }, { status: 404 });
  const timing = createTimings();
  const attachments = await timing.run('attachments', () => fetchMessageAttachments(sql, id));
  const calendar_invite = await timing.run('invite', () =>
    extractCalendarInvite(attachments, deps.readBlob),
  );
  return timing.response(Response.json({ calendar_invite }));
}

/**
 * Every column a message's Meilisearch document is built from lives on
 * `messages` or in its label set, so both handlers below that change one have
 * to invalidate the index. They do it two ways: `search_indexed_at = NULL`
 * marks the row as drifted for the background sweep (the safety net that
 * repairs the row even if nothing else runs), and `onMessageChanged` lets the
 * Worker fire a best-effort sync straight away. The callback is injected
 * rather than called directly so the handlers stay pure — the ExecutionContext
 * and the sync's own database client belong to worker.js.
 *
 * @typedef {{ onMessageChanged?: (messageId: string) => void }} ReindexDeps
 */

/**
 * Apply or remove one of the caller's user labels on a message they own.
 * Both the message and the label are ownership-checked before the join row
 * changes, and the message's full label set is returned so the reader can
 * resync its pills. add_label is idempotent (ON CONFLICT DO NOTHING).
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} messageId
 * @param {'add_label' | 'remove_label'} action
 * @param {any} rawLabelId
 * @param {ReindexDeps} deps
 */
async function mutateMessageLabel(sql, userId, messageId, action, rawLabelId, deps) {
  const labelId = validId(rawLabelId) ? String(rawLabelId) : null;
  if (!labelId) {
    return Response.json({ error: 'A valid label_id is required' }, { status: 400 });
  }

  // Run the ownership-scoped mutation first; use RETURNING so we know whether
  // it actually changed a row. If it didn't, we fall back to an explicit
  // ownership check to return the right 404. This closes the race where an
  // ownership change between a parallel check and the mutation could make the
  // response claim success when nothing happened.
  //
  // The drift mark shares the mutation's transaction (the same idiom labels.js
  // uses for renames/deletes). The mark touches `messages`, not
  // `message_labels`, so it cannot ride along on the mutation the way
  // patchMessage's does — and running it afterwards on its own would let a
  // failed mark turn an already-committed label change into a 500, or leave the
  // row drifted with neither a mark nor a sync if the isolate went away between
  // the two. In one transaction they both land or neither does.
  const changed = await sql.begin(async (tx) => {
    const mutationResult =
      action === 'add_label'
        ? await tx`
            INSERT INTO message_labels (message_id, label_id)
            SELECT ${messageId}, ${labelId}
            WHERE EXISTS (
              SELECT 1 FROM messages m WHERE m.id = ${messageId} AND m.user_id = ${userId}
            ) AND EXISTS (
              SELECT 1 FROM labels l WHERE l.id = ${labelId} AND l.user_id = ${userId} AND l.kind = 'user'
            )
            ON CONFLICT DO NOTHING
            RETURNING label_id
          `
        : await tx`
            DELETE FROM message_labels
            WHERE message_id = ${messageId} AND label_id = ${labelId}
              AND EXISTS (
                SELECT 1 FROM messages m WHERE m.id = ${messageId} AND m.user_id = ${userId}
              )
            RETURNING label_id
          `;
    if (mutationResult.length === 0) return false;
    await tx`UPDATE messages SET search_indexed_at = NULL WHERE id = ${messageId}`;
    return true;
  });
  if (!changed) {
    const [owns] = await sql`
      SELECT
        EXISTS (
          SELECT 1 FROM messages m WHERE m.id = ${messageId} AND m.user_id = ${userId}
        ) AS message,
        EXISTS (
          SELECT 1 FROM labels l WHERE l.id = ${labelId} AND l.user_id = ${userId} AND l.kind = 'user'
        ) AS label
    `;
    if (!owns?.message) {
      return Response.json({ error: 'Message not found' }, { status: 404 });
    }
    if (!owns?.label) {
      return Response.json({ error: 'Label not found' }, { status: 404 });
    }
    // Both exist but the mutation was a no-op (duplicate add or removing a
    // non-existent join) — return the current label set, which is idempotent.
    // The document is unchanged, so there is nothing to reindex.
  }

  // Return the same {name, color, kind} shape the labels list endpoint uses.
  const labels = await sql`
    SELECT l.name, l.color, l.kind
    FROM message_labels ml
    JOIN labels l ON l.id = ml.label_id
    WHERE ml.message_id = ${messageId}
    ORDER BY l.name
  `;
  if (changed) deps.onMessageChanged?.(messageId);
  return Response.json({ labels });
}

/**
 * Replace or clear the one Category attached to an owned message. Categories
 * are deliberately not part of the Meilisearch document, so this updates the
 * message row (which also emits the normal Realtime inbox ping) without
 * scheduling an unnecessary search reindex.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} messageId
 * @param {any} rawCategoryId
 */
async function setMessageCategory(sql, userId, messageId, rawCategoryId) {
  const clearing = rawCategoryId === null;
  const categoryId = validId(rawCategoryId) ? String(rawCategoryId) : null;
  if (!clearing && !categoryId) {
    return Response.json({ error: 'category_id must be a valid UUID or null' }, { status: 400 });
  }

  const changed = categoryId
    ? await sql`
        UPDATE messages m
        SET category_id = ${categoryId}
        WHERE m.id = ${messageId} AND m.user_id = ${userId} AND NOT m.is_deleted
          AND m.category_id IS DISTINCT FROM ${categoryId}
          AND EXISTS (
            SELECT 1 FROM email_categories c
            WHERE c.id = ${categoryId} AND c.user_id = ${userId}
          )
        RETURNING m.id
      `
    : await sql`
        UPDATE messages m
        SET category_id = NULL
        WHERE m.id = ${messageId} AND m.user_id = ${userId} AND NOT m.is_deleted
          AND m.category_id IS NOT NULL
        RETURNING m.id
      `;

  if (changed.length === 0) {
    const [owns] = categoryId
      ? await sql`
          SELECT
            EXISTS (
              SELECT 1 FROM messages m
              WHERE m.id = ${messageId} AND m.user_id = ${userId} AND NOT m.is_deleted
            ) AS message,
            EXISTS (
              SELECT 1 FROM email_categories c
              WHERE c.id = ${categoryId} AND c.user_id = ${userId}
            ) AS category
        `
      : await sql`
          SELECT
            EXISTS (
              SELECT 1 FROM messages m
              WHERE m.id = ${messageId} AND m.user_id = ${userId} AND NOT m.is_deleted
            ) AS message,
            true AS category
        `;
    if (!owns?.message) {
      return Response.json({ error: 'Message not found' }, { status: 404 });
    }
    if (!owns?.category) {
      return Response.json({ error: 'Category not found' }, { status: 404 });
    }
  }

  const [category] = await sql`
    SELECT c.id, c.name, c.color
    FROM messages m
    JOIN email_categories c ON c.id = m.category_id AND c.user_id = m.user_id
    WHERE m.id = ${messageId} AND m.user_id = ${userId} AND NOT m.is_deleted
  `;
  return Response.json({ category: category ?? null });
}

/**
 * @typedef {{
 *   requestPublicHttps: (url: string, options: {method?: string, headers?: Record<string,string>, body?: string, timeoutMs?: number}) => Promise<{status: number}>,
 *   resendApiKey: string | undefined,
 *   emailFrom: string | undefined,
 *   sendEmail: (options: {apiKey: string, from: string, to: string[], subject: string, text: string}) => Promise<void>,
 *   aiUnsubscribe?: (target: {url: string, recipientEmail: string | null}) => Promise<{ok: boolean, reason?: string}>,
 * }} UnsubscribeDeps
 */

/**
 * First `to` address from messages.recipients ({"to": [{name, address}], ...}
 * jsonb, occasionally double-encoded as a string by old ingest rows) — the
 * one piece of user data the AI unsubscribe tier may type into a sender's
 * form. Returns null rather than guessing when the shape is unexpected.
 *
 * @param {any} recipients
 */
export function recipientAddress(recipients) {
  let value = recipients;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const first = value?.to?.[0];
  const address = typeof first === 'string' ? first : first?.address;
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(trimmed) ? trimmed : null;
}

/**
 * POST /messages — { id, action: 'unsubscribe' } acts on a message owned by
 * the authenticated user. Parses the (untrusted) List-Unsubscribe headers
 * and, in preference order: performs a server-side, SSRF-guarded one-click
 * POST; sends a mailto unsubscribe via Resend; drives the sender's
 * unsubscribe page with AI (only when the client opted in via allow_ai —
 * older clients keep the manual contract below); or returns a safe target
 * for the client to open manually. No DB writes.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @param {UnsubscribeDeps} deps
 * @param {boolean} [allowAi]
 */
async function unsubscribe(sql, userId, id, deps, allowAi = false) {
  const rows = await sql`
    SELECT m.headers, m.recipients
    FROM messages m
    WHERE m.id = ${id} AND m.user_id = ${userId}
  `;
  if (rows.length === 0) {
    return Response.json({ error: 'Message not found' }, { status: 404 });
  }

  const parsed = parseListUnsubscribe(rows[0].headers);
  if (!parsed) {
    return Response.json({ error: 'Message has no unsubscribe information' }, { status: 422 });
  }
  const { oneClick, url, mailto } = parsed;

  // 1. RFC 8058 one-click: server-side POST to any SSRF-safe https URL. The
  // request boundary (requestPublicHttps) rejects non-https and private/
  // internal targets via DNS-over-HTTPS before connecting; the residual
  // DNS-rebinding window is accepted because the POST carries a fixed body
  // and only the status code is read back — the response never reaches the
  // client.
  if (oneClick && url && isSafeUnsubscribeUrl(url)) {
    const host = new URL(url).hostname.toLowerCase();
    try {
      const resp = await deps.requestPublicHttps(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        timeoutMs: 10_000,
      });
      if (resp.status < 400) {
        return Response.json({ status: 'unsubscribed', method: 'one-click' });
      }
      console.log(
        JSON.stringify({ event: 'one_click_unsubscribe_failed', host, status: resp.status }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          event: 'one_click_unsubscribe_error',
          host,
          message: /** @type {Error} */ (error).message,
        }),
      );
    }
    // fall through to the fallbacks below on any failure/timeout — never 500.
  }

  // 2. mailto unsubscribe via Resend (when configured).
  if (mailto && deps.resendApiKey && deps.emailFrom) {
    try {
      await deps.sendEmail({
        apiKey: deps.resendApiKey,
        from: deps.emailFrom,
        to: [mailto.address],
        subject: mailto.subject || 'unsubscribe',
        text: 'Please unsubscribe me from this mailing list.',
      });
      return Response.json({ status: 'unsubscribed', method: 'mailto' });
    } catch (error) {
      console.log(
        JSON.stringify({
          event: 'mailto_unsubscribe_failed',
          message: /** @type {Error} */ (error).message,
        }),
      );
      // Resend failed — try the link fallback, else 502.
      if (url && isSafeUnsubscribeUrl(url)) {
        return Response.json({ status: 'manual', method: 'link', url });
      }
      return Response.json({ error: 'Failed to unsubscribe' }, { status: 502 });
    }
  }

  // 3. AI-driven unsubscribe on the sender's page (when configured and the
  // client opted in), else a safe https link to open manually. The attempt
  // never throws; on failure the client shows a failed state rather than the
  // link, so the response still carries the url for clients that want it.
  if (url && isSafeUnsubscribeUrl(url)) {
    if (allowAi && deps.aiUnsubscribe) {
      const outcome = await deps.aiUnsubscribe({
        url,
        recipientEmail: recipientAddress(rows[0].recipients),
      });
      if (outcome?.ok) {
        return Response.json({ status: 'unsubscribed', method: 'ai' });
      }
      return Response.json({ status: 'ai_failed', method: 'ai', url });
    }
    return Response.json({ status: 'manual', method: 'link', url });
  }

  // 4. mailto with no Resend key: hand the client a mailto: URI to open.
  if (mailto) {
    const mailtoUri =
      'mailto:' +
      mailto.address +
      (mailto.subject ? '?subject=' + encodeURIComponent(mailto.subject) : '');
    return Response.json({ status: 'manual', method: 'mailto', mailto: mailtoUri });
  }

  // 5. Nothing safe/usable (e.g. only an unsafe URL).
  return Response.json({ error: 'No safe unsubscribe method is available' }, { status: 422 });
}

/**
 * POST /messages — unsubscribe, label/category edits, mute_thread/unmute_thread, or
 * mark_not_important/undo_not_important.
 * Muting applies to the owned message's entire conversation and clears queued alerts.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {UnsubscribeDeps & ReindexDeps} deps
 */
export async function postMessage(sql, userId, body, deps) {
  const { action } = body ?? {};
  const id = validId(body?.id) ? String(body.id) : null;
  if (!id) {
    return Response.json({ error: 'A valid id is required' }, { status: 400 });
  }

  if (action === 'mute_thread' || action === 'unmute_thread') {
    const muted = action === 'mute_thread';
    const thread = await sql.begin(async (tx) => {
      const [changed] = await tx`
        UPDATE threads t SET is_muted = ${muted}
        FROM messages m
        WHERE m.id = ${id} AND m.user_id = ${userId} AND NOT m.is_deleted
          AND t.id = m.thread_id AND t.user_id = ${userId}
        RETURNING t.id, t.is_muted
      `;
      if (changed && muted) {
        // Discard queued alerts so unmuting never replays muted replies.
        await tx`
          DELETE FROM browser_notification_events event
          USING messages m
          WHERE event.message_id = m.id AND m.thread_id = ${changed.id}
            AND event.user_id = ${userId} AND m.user_id = ${userId}
        `;
      }
      return changed;
    });
    if (!thread) return Response.json({ error: 'Message not found' }, { status: 404 });
    return Response.json({ thread });
  }

  if (action === 'add_label' || action === 'remove_label') {
    return mutateMessageLabel(sql, userId, id, action, body.label_id, deps);
  }

  if (action === 'set_category') {
    return setMessageCategory(sql, userId, id, body.category_id);
  }

  if (action === 'mark_not_important') {
    return markNotImportant(sql, userId, id);
  }

  if (action === 'undo_not_important') {
    return undoNotImportant(sql, userId, id, body.previous);
  }

  if (action !== 'unsubscribe') {
    return Response.json({ error: 'A valid id and action are required' }, { status: 400 });
  }

  let allowed;
  try {
    allowed = await allowRequest(sql, userId, 'unsubscribe', UNSUBSCRIBE_RATE_LIMIT);
  } catch (error) {
    console.error('unsubscribe quota enforcement failed:', /** @type {Error} */ (error).message);
    return Response.json({ error: 'Unsubscribe is temporarily unavailable' }, { status: 503 });
  }
  if (!allowed) {
    return Response.json({ error: 'Too many unsubscribe actions, slow down' }, { status: 429 });
  }

  return unsubscribe(sql, userId, id, deps, body.allow_ai === true);
}

/**
 * "Not important" from the reader: remembers the sender so classification
 * (mail-app-ingest enrich.js) never rates their mail high priority or files it
 * under a category named Important, and takes this message out of Important
 * now by lowering a high priority to normal and clearing such a category.
 * Returns the previous values so the client can offer Undo.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} messageId
 */
async function markNotImportant(sql, userId, messageId) {
  const result = await sql.begin(async (tx) => {
    const [message] = await tx`
      SELECT lower(btrim(m.from_address)) AS address, m.category_id, ai.priority,
             -- Categories count as Important by name, as in Cookie-Web's tabs.
             COALESCE(lower(btrim(c.name)) = 'important', false) AS important_category
      FROM messages m
      LEFT JOIN message_ai ai ON ai.message_id = m.id
      LEFT JOIN email_categories c ON c.id = m.category_id AND c.user_id = m.user_id
      WHERE m.id = ${messageId} AND m.user_id = ${userId} AND NOT m.is_deleted AND NOT m.is_sent
      FOR UPDATE OF m
    `;
    if (!message) return null;
    if (message.address) {
      await tx`
        INSERT INTO sender_importance_feedback (user_id, address)
        VALUES (${userId}, ${message.address})
        ON CONFLICT (user_id, address) DO NOTHING
      `;
    }
    const lowered = message.priority === 'high';
    if (lowered) {
      await tx`
        UPDATE message_ai SET priority = 'normal', updated_at = now()
        WHERE message_id = ${messageId} AND priority = 'high'
      `;
    }
    if (message.important_category) {
      await tx`UPDATE messages SET category_id = NULL WHERE id = ${messageId}`;
    }
    return {
      sender: message.address || null,
      priority: lowered ? 'normal' : (message.priority ?? null),
      category_id: message.important_category ? null : (message.category_id ?? null),
      previous: { priority: message.priority ?? null, category_id: message.category_id ?? null },
    };
  });
  if (!result) return Response.json({ error: 'Message not found' }, { status: 404 });
  return Response.json(result);
}

/**
 * Undo for markNotImportant: forgets the sender and puts back the priority
 * and category it changed, unless something else has changed them since.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} messageId
 * @param {any} previous
 */
async function undoNotImportant(sql, userId, messageId, previous) {
  const priority = previous?.priority === 'high' ? 'high' : null;
  const categoryId = validId(previous?.category_id) ? String(previous.category_id) : null;
  const restored = await sql.begin(async (tx) => {
    const [message] = await tx`
      SELECT lower(btrim(m.from_address)) AS address
      FROM messages m
      WHERE m.id = ${messageId} AND m.user_id = ${userId} AND NOT m.is_deleted
      FOR UPDATE OF m
    `;
    if (!message) return false;
    if (message.address) {
      await tx`
        DELETE FROM sender_importance_feedback
        WHERE user_id = ${userId} AND address = ${message.address}
      `;
    }
    if (priority) {
      await tx`
        UPDATE message_ai SET priority = 'high', updated_at = now()
        WHERE message_id = ${messageId} AND priority = 'normal'
      `;
    }
    if (categoryId) {
      await tx`
        UPDATE messages m SET category_id = ${categoryId}
        WHERE m.id = ${messageId} AND m.category_id IS NULL
          AND EXISTS (
            SELECT 1 FROM email_categories c WHERE c.id = ${categoryId} AND c.user_id = ${userId}
          )
      `;
    }
    return true;
  });
  if (!restored) return Response.json({ error: 'Message not found' }, { status: 404 });
  return Response.json({ restored: true });
}

/**
 * Records the user's own spam verdict for a message they own. The Spam
 * folder, the inbox unread badge, the daily digest and the search index all
 * read `message_ai.spam_verdict`, so a user report writes the same column the
 * AI classifier does instead of introducing a second flag. The row is
 * stamped `provider = 'user'` and `status = 'completed'`: enrichment no-ops
 * on completed rows and its upsert skips user-provided rows, so a later or
 * in-flight classification can never overturn what the user decided.
 *
 * The AI classifier also pins its spam to the system "Spam" label so the row
 * wears a pill; a user report applies the same label, and clearing the
 * report removes it again, so both kinds of spam look alike in the list.
 *
 * @param {import('postgres').TransactionSql} tx
 * @param {string} messageId
 * @param {boolean} isSpam
 */
async function applySpamVerdict(tx, messageId, isSpam) {
  const verdict = isSpam ? 'spam' : 'inbox';
  const reason = isSpam ? 'Reported as spam by the user' : 'Marked not spam by the user';
  await tx`
    INSERT INTO message_ai (
      message_id, status, spam_verdict, spam_score, spam_reason,
      provider, model, prompt_version, error_code, processed_at, updated_at
    ) VALUES (
      ${messageId}, 'completed', ${verdict}, NULL, ${reason},
      'user', NULL, 'user-report', NULL, now(), now()
    )
    ON CONFLICT (message_id) DO UPDATE SET
      status = 'completed', spam_verdict = EXCLUDED.spam_verdict,
      spam_score = NULL, spam_reason = EXCLUDED.spam_reason,
      provider = 'user', model = NULL, prompt_version = EXCLUDED.prompt_version,
      error_code = NULL, processed_at = now(), updated_at = now()
  `;
  if (isSpam) {
    const [spamLabel] = await tx`
      INSERT INTO labels (user_id, name, color, kind, description, auto_apply)
      SELECT m.user_id, 'Spam', '#64748b', 'system', 'High-confidence spam detected by Cookie AI', false
      FROM messages m WHERE m.id = ${messageId}
      ON CONFLICT (user_id, name) DO UPDATE
      SET kind = 'system', auto_apply = false
      RETURNING id
    `;
    if (spamLabel) {
      await tx`
        INSERT INTO message_labels (message_id, label_id, source)
        VALUES (${messageId}, ${spamLabel.id}, 'manual')
        ON CONFLICT (message_id, label_id) DO NOTHING
      `;
    }
  } else {
    await tx`
      DELETE FROM message_labels ml
      USING labels l
      WHERE ml.message_id = ${messageId}
        AND l.id = ml.label_id
        AND l.kind = 'system'
        AND l.name = 'Spam'
    `;
  }
}

/**
 * PATCH /messages — updates is_unread/is_starred/is_archived/is_deleted/
 * is_spam and/or scheduled_for on a message owned by the authenticated user.
 * is_spam is the user's own verdict (see applySpamVerdict); it lives in
 * message_ai rather than on the messages row, so a request that carries it
 * runs as a transaction: the ownership-checked UPDATE first, then the verdict.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {ReindexDeps} [deps]
 */
export async function patchMessage(sql, userId, body, deps = {}) {
  const { is_unread, is_starred, is_archived, is_deleted, is_spam } = body ?? {};
  const flags = [is_unread, is_starred, is_archived, is_deleted, is_spam];
  const id = validId(body?.id) ? String(body.id) : null;
  const flagsValid = flags.every((f) => f === undefined || f === true || f === false);
  const hasScheduledChange = Object.hasOwn(body ?? {}, 'scheduled_for');
  const scheduledFor =
    hasScheduledChange && body.scheduled_for !== null ? String(body.scheduled_for ?? '') : null;
  const scheduledForValid =
    !hasScheduledChange || scheduledFor === null || Number.isFinite(Date.parse(scheduledFor));
  const hasChange = flags.some((f) => f === true || f === false) || hasScheduledChange;
  if (!id || !flagsValid || !scheduledForValid || !hasChange) {
    return Response.json(
      { error: 'id and at least one valid change are required' },
      { status: 400 },
    );
  }

  /** @param {import('postgres').Sql | import('postgres').TransactionSql} tx */
  const update = async (tx) => {
    const rows = await tx`
      UPDATE messages m SET
        is_unread   = COALESCE(${is_unread ?? null}::boolean, m.is_unread),
        is_starred  = COALESCE(${is_starred ?? null}::boolean, m.is_starred),
        is_archived = COALESCE(${is_archived ?? null}::boolean, m.is_archived),
        is_deleted  = COALESCE(${is_deleted ?? null}::boolean, m.is_deleted),
        -- Every column this statement writes (and, via is_spam, the verdict
        -- written after it) is part of the message's search document, so
        -- clear the stamp in the same statement: the row is marked as
        -- drifted the instant it changes, whatever happens to the sync below.
        search_indexed_at = NULL,
        scheduled_for = CASE
          WHEN ${hasScheduledChange}::boolean THEN ${scheduledFor}::timestamptz
          ELSE m.scheduled_for
        END
      WHERE m.id = ${id} AND m.user_id = ${userId}
      RETURNING m.id, m.is_unread, m.is_starred, m.is_archived, m.is_deleted, m.scheduled_for
    `;
    if (rows.length === 0) return null;
    if (is_spam === undefined) return rows[0];
    // The UPDATE above is the ownership check: the verdict only lands on a
    // row the caller was allowed to change.
    await applySpamVerdict(/** @type {import('postgres').TransactionSql} */ (tx), id, is_spam);
    return { ...rows[0], is_spam };
  };
  const message = is_spam === undefined ? await update(sql) : await sql.begin(update);
  if (!message) {
    return Response.json({ error: 'Message not found' }, { status: 404 });
  }
  deps.onMessageChanged?.(id);
  return Response.json({ message });
}
