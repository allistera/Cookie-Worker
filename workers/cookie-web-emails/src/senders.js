import { lockOutOfOfficeDispatch, normaliseAddress } from '../../../shared/outOfOffice.js';
import { validId } from '../../../shared/pagination.js';

const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** @param {unknown} value */
function exactAddress(value) {
  const address = normaliseAddress(value);
  return address && !address.includes('*') ? address : null;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {URL} url */
export async function getSenders(sql, userId, url) {
  const address = url.searchParams.has('address')
    ? exactAddress(url.searchParams.get('address'))
    : null;
  const after = url.searchParams.get('after') || '';
  if ((url.searchParams.has('address') && !address) || (after && !exactAddress(after)))
    return reply({ error: 'Use one exact email address.' }, 400);
  const [owner] =
    await sql`SELECT prefs -> 'senderScreening' AS enabled FROM users WHERE id = ${userId}`;
  if (!owner) return reply({ error: 'User not found' }, 404);
  const rows = await sql`SELECT address, decision FROM sender_decisions
    WHERE user_id = ${userId} AND address > ${after}
      ${address ? sql`AND address = ${address}` : sql``}
    ORDER BY address LIMIT 51`;
  return reply({
    enabled: owner.enabled === true,
    decisions: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? rows[49].address : null,
  });
}

/**
 * Writes serialize with both dispatch and initial-arrival snapshots. Never
 * change this order: responder FIRST, then the short ingest-owner lock.
 * Acceptance restores held mail; removing a block leaves it held when screening
 * is on. Neither operation changes read/archive/spam or revives past auto replies.
 * @param {import('postgres').Sql} sql @param {string} userId @param {any} body
 */
export async function putSenders(sql, userId, body) {
  const action = body?.action;
  if (!['settings', 'block', 'accept', 'unblock', 'forget', 'restore'].includes(action))
    return reply({ error: 'Choose a sender action.' }, 400);
  if (action === 'settings' && typeof body.enabled !== 'boolean')
    return reply({ error: 'Choose whether screening is enabled.' }, 400);
  const address = exactAddress(body.address);
  if (!['settings', 'restore'].includes(action) && !address)
    return reply({ error: 'Use one exact email address, without a name or wildcard.' }, 400);
  if (
    ((body.messageId !== undefined && body.messageId !== null) || action === 'restore') &&
    !validId(body.messageId || '')
  )
    return reply({ error: 'Choose a valid message.' }, 400);

  return sql.begin(async (tx) => {
    await lockOutOfOfficeDispatch(tx, userId);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
    const [owner] = await tx`SELECT prefs -> 'senderScreening' AS enabled FROM users
      WHERE id = ${userId} FOR UPDATE`;
    if (!owner) return reply({ error: 'User not found' }, 404);
    if (action === 'settings') {
      await tx`UPDATE users SET prefs = jsonb_set(coalesce(prefs, '{}'::jsonb), '{senderScreening}', ${tx.json(body.enabled)}, true)
        WHERE id = ${userId}`;
      return reply({ enabled: body.enabled });
    }
    if (body.messageId) {
      const [message] = await tx`SELECT from_address, screening_status FROM messages
        WHERE id = ${body.messageId} AND user_id = ${userId} AND NOT is_sent AND NOT is_deleted FOR UPDATE`;
      if (!message || (action !== 'restore' && normaliseAddress(message.from_address) !== address))
        return reply({ error: 'Message not found for this sender.' }, 404);
      if (action === 'restore') {
        const [blocked] = await tx`SELECT address FROM sender_decisions
          WHERE user_id = ${userId} AND address = ${normaliseAddress(message.from_address) ?? ''} AND decision = 'blocked'`;
        if (blocked)
          return reply(
            { error: 'Unblock or accept this sender before restoring their mail.' },
            409,
          );
        await tx`UPDATE messages SET screening_status = 'allowed', search_indexed_at = NULL
          WHERE id = ${body.messageId} AND user_id = ${userId} AND screening_status <> 'allowed'`;
        return reply({ restored: true });
      }
    }
    if (action === 'block' || action === 'accept') {
      await tx`INSERT INTO sender_decisions (user_id, address, decision)
        VALUES (${userId}, ${address}, ${action === 'block' ? 'blocked' : 'accepted'})
        ON CONFLICT (user_id, address) DO UPDATE SET decision = EXCLUDED.decision, updated_at = now()`;
    } else {
      // An outdated Unblock button must not erase a newer Accept decision.
      await tx`DELETE FROM sender_decisions WHERE user_id = ${userId} AND address = ${address}
        AND decision = ${action === 'unblock' ? 'blocked' : 'accepted'}`;
    }
    const [current] =
      await tx`SELECT decision FROM sender_decisions WHERE user_id = ${userId} AND address = ${address}`;
    const status =
      current?.decision === 'blocked'
        ? 'blocked'
        : current?.decision === 'accepted' || owner.enabled !== true
          ? 'allowed'
          : 'held';
    if (action === 'block') {
      // Suppress even an already-queued reply/alert whose different envelope
      // identity would otherwise evade the displayed From-address decision.
      // Sticky suppression avoids replaying old replies after a later unblock.
      await tx`UPDATE messages SET auto_reply_suppressed = true
        WHERE user_id = ${userId} AND lower(btrim(from_address)) = ${address}
          AND NOT is_sent AND NOT auto_reply_suppressed`;
      await tx`DELETE FROM browser_notification_events event USING messages m
        WHERE event.message_id = m.id AND event.user_id = ${userId} AND m.user_id = ${userId}
          AND lower(btrim(m.from_address)) = ${address}`;
      await tx`DELETE FROM ntfy_notification_events event USING messages m
        WHERE event.message_id = m.id AND event.user_id = ${userId} AND m.user_id = ${userId}
          AND lower(btrim(m.from_address)) = ${address} AND event.published_at IS NULL`;
    }
    // Only held mail and the explicitly selected reader message move. Older
    // ordinary mail remains where it was; accepting never forces it into Inbox.
    const rows = await tx`UPDATE messages SET screening_status = ${status},
        auto_reply_suppressed = true, search_indexed_at = NULL
      WHERE user_id = ${userId} AND lower(btrim(from_address)) = ${address}
        AND NOT is_sent AND NOT is_deleted
        AND (screening_status <> 'allowed' OR (${action === 'block'} AND id = ${body.messageId ?? null}::uuid))
      RETURNING id, thread_id`;
    if (rows.length) {
      await tx`UPDATE threads SET ai_summary = NULL, ai_summary_message_id = NULL, ai_summary_updated_at = NULL
        WHERE user_id = ${userId} AND id = ANY(${rows.map((row) => row.thread_id)}::uuid[])`;
    }
    return reply({ address, decision: current?.decision ?? null, status, updated: rows.length });
  });
}
