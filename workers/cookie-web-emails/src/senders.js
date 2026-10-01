import { lockOutOfOfficeDispatch, normaliseAddress } from '../../../shared/outOfOffice.js';
import { validId } from '../../../shared/pagination.js';

const reply = (body, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

/** @param {unknown} value */
function exactAddress(value) {
  const address = normaliseAddress(value);
  return address && !address.includes('*') ? address : null;
}

// Shared mailbox providers: a domain decision here would accept or block
// everyone who uses them, so their senders keep exact-address decisions.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'aol.com',
  'btinternet.com',
  'fastmail.com',
  'gmail.com',
  'gmx.co.uk',
  'gmx.com',
  'gmx.net',
  'googlemail.com',
  'hey.com',
  'hotmail.co.uk',
  'hotmail.com',
  'icloud.com',
  'live.co.uk',
  'live.com',
  'mac.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.com',
  'sky.com',
  'talktalk.net',
  'tutanota.com',
  'virginmedia.com',
  'yahoo.co.uk',
  'yahoo.com',
  'yandex.com',
  'ymail.com',
  'zoho.com',
]);

/**
 * Resolves what a request names into the decision key it writes:
 * - an address on a company domain -> '@domain' (covers its subdomains too);
 * - an address on a public provider -> the exact address;
 * - '@domain' or a bare domain (from Settings) -> '@domain'.
 * `sender` is the exact address when one was given, else null.
 *
 * @param {unknown} value
 * @returns {{key: string, sender: string | null} | {error: string} | null}
 */
export function senderKey(value) {
  const address = exactAddress(value);
  if (address) {
    const domain = address.slice(address.lastIndexOf('@') + 1);
    return { key: PUBLIC_EMAIL_DOMAINS.has(domain) ? address : `@${domain}`, sender: address };
  }
  const domain = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
  if (!exactAddress(`x@${domain}`)) return null;
  if (PUBLIC_EMAIL_DOMAINS.has(domain))
    return { error: `${domain} is a shared email provider; use the exact address instead.` };
  return { key: `@${domain}`, sender: null };
}

// Parameters for the "messages a decision key covers" condition: one exact
// address, or (domain set) that domain and its subdomains. Plain values rather
// than a nested fragment, so each statement stays one self-contained query.
/** @param {string} key */
function scope(key) {
  const domain = key.startsWith('@') ? key.slice(1) : '';
  return { exact: key, domain, suffix: `.${domain}` };
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {URL} url */
export async function getSenders(sql, userId, url) {
  const address = url.searchParams.has('address')
    ? exactAddress(url.searchParams.get('address'))
    : null;
  const after = url.searchParams.get('after') || '';
  if (url.searchParams.has('address') && !address)
    return reply({ error: 'Use one exact email address.' }, 400);
  const [owner] =
    await sql`SELECT prefs -> 'senderScreening' AS enabled FROM users WHERE id = ${userId}`;
  if (!owner) return reply({ error: 'User not found' }, 404);
  // With ?address=, the one decision that applies to that sender: its own
  // row, else the most specific domain row covering it.
  const rows = address
    ? await sql`SELECT address, decision FROM effective_sender_decision(${userId}, ${address})`
    : await sql`SELECT address, decision FROM sender_decisions
        WHERE user_id = ${userId} AND address > ${after}
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
 *
 * Accept and Block write a domain decision ('@example.com', covering its
 * subdomains) unless the sender uses a public email provider, which keeps an
 * exact-address decision. An exact-address row still overrides its domain.
 * @param {import('postgres').Sql} sql @param {string} userId @param {any} body
 */
export async function putSenders(sql, userId, body) {
  const action = body?.action;
  if (!['settings', 'block', 'accept', 'unblock', 'forget', 'restore'].includes(action))
    return reply({ error: 'Choose a sender action.' }, 400);
  if (action === 'settings' && typeof body.enabled !== 'boolean')
    return reply({ error: 'Choose whether screening is enabled.' }, 400);
  const target = ['settings', 'restore'].includes(action) ? null : senderKey(body.address);
  if (target && 'error' in target) return reply({ error: target.error }, 400);
  if (!['settings', 'restore'].includes(action) && !target)
    return reply({ error: 'Use one email address or domain, without a name or wildcard.' }, 400);
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
      if (
        !message ||
        (action !== 'restore' && normaliseAddress(message.from_address) !== target?.sender)
      )
        return reply({ error: 'Message not found for this sender.' }, 404);
      if (action === 'restore') {
        const [current] = await tx`SELECT decision
          FROM effective_sender_decision(${userId}, ${message.from_address})`;
        if (current?.decision === 'blocked')
          return reply(
            { error: 'Unblock or accept this sender before restoring their mail.' },
            409,
          );
        await tx`UPDATE messages SET screening_status = 'allowed', search_indexed_at = NULL
          WHERE id = ${body.messageId} AND user_id = ${userId} AND screening_status <> 'allowed'`;
        return reply({ restored: true });
      }
    }
    // Non-restore actions were rejected above without a target.
    const { key, sender } = /** @type {{key: string, sender: string | null}} */ (target);
    if (action === 'block' || action === 'accept') {
      await tx`INSERT INTO sender_decisions (user_id, address, decision)
        VALUES (${userId}, ${key}, ${action === 'block' ? 'blocked' : 'accepted'})
        ON CONFLICT (user_id, address) DO UPDATE SET decision = EXCLUDED.decision, updated_at = now()`;
      // An older exact-address row for this sender would otherwise override
      // the new domain decision for the very sender it was made from.
      if (sender && sender !== key)
        await tx`DELETE FROM sender_decisions WHERE user_id = ${userId} AND address = ${sender}`;
    } else {
      // An outdated Unblock button must not erase a newer Accept decision.
      // Both the sender's own row and its key go, so older exact-address
      // decisions can still be removed from the reader.
      const keys = sender && sender !== key ? [key, sender] : [key];
      await tx`DELETE FROM sender_decisions WHERE user_id = ${userId} AND address = ANY(${keys})
        AND decision = ${action === 'unblock' ? 'blocked' : 'accepted'}`;
    }
    const [stored] =
      await tx`SELECT decision FROM sender_decisions WHERE user_id = ${userId} AND address = ${key}`;
    // What now applies to the named sender (or, for a bare domain, to it).
    const [effective] = await tx`SELECT decision
      FROM effective_sender_decision(${userId}, ${sender ?? 'x' + key})`;
    const status =
      effective?.decision === 'blocked'
        ? 'blocked'
        : effective?.decision === 'accepted' || owner.enabled !== true
          ? 'allowed'
          : 'held';
    const rows = await applyDisposition(
      tx,
      userId,
      key,
      action,
      owner.enabled === true,
      body.messageId ?? null,
    );
    if (rows.length) {
      await tx`UPDATE threads SET ai_summary = NULL, ai_summary_message_id = NULL, ai_summary_updated_at = NULL
        WHERE user_id = ${userId} AND id = ANY(${rows.map((row) => row.thread_id)}::uuid[])`;
    }
    // Other sender addresses whose mail this decision moved (a domain covers
    // several), so callers can skip them in bulk actions and say so.
    const related = [...new Set(rows.map((row) => row.address))]
      .filter((address) => address !== sender)
      .sort();
    return reply({
      address: key,
      decision: stored?.decision ?? null,
      effective: effective?.decision ?? null,
      status,
      updated: rows.length,
      related,
    });
  });
}

/**
 * Re-screens the mail a decision key covers, each message by the decision that
 * now applies to its own sender (an exact-address row can differ from its
 * domain). Only held/blocked mail and the explicitly selected reader message
 * move; older ordinary mail remains where it was, and accepting never forces
 * it into Inbox.
 *
 * @param {import('postgres').TransactionSql} tx
 * @param {string} userId
 * @param {string} key
 * @param {string} action
 * @param {boolean} screeningEnabled
 * @param {string | null} messageId
 */
async function applyDisposition(tx, userId, key, action, screeningEnabled, messageId) {
  const { exact, domain, suffix } = scope(key);
  if (action === 'block') {
    // Suppress even an already-queued reply/alert whose different envelope
    // identity would otherwise evade the displayed From-address decision.
    // Sticky suppression avoids replaying old replies after a later unblock.
    const blocked = await tx`SELECT m.id FROM messages m
      CROSS JOIN LATERAL effective_sender_decision(m.user_id, m.from_address) d
      WHERE m.user_id = ${userId} AND NOT m.is_sent AND d.decision = 'blocked'
        AND (lower(btrim(m.from_address)) = ${exact} OR (${domain} <> '' AND (
          regexp_replace(lower(btrim(m.from_address)), '^.*@', '') = ${domain}
          OR right(regexp_replace(lower(btrim(m.from_address)), '^.*@', ''), length(${suffix})) = ${suffix})))`;
    const ids = blocked.map((row) => row.id);
    if (ids.length) {
      await tx`UPDATE messages SET auto_reply_suppressed = true
        WHERE user_id = ${userId} AND id = ANY(${ids}::uuid[]) AND NOT auto_reply_suppressed`;
      await tx`DELETE FROM browser_notification_events
        WHERE user_id = ${userId} AND message_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM ntfy_notification_events
        WHERE user_id = ${userId} AND message_id = ANY(${ids}::uuid[]) AND published_at IS NULL`;
    }
  }
  return tx`UPDATE messages target SET screening_status = scoped.status,
      auto_reply_suppressed = true, search_indexed_at = NULL
    FROM (
      SELECT m.id, CASE d.decision
          WHEN 'blocked' THEN 'blocked'
          WHEN 'accepted' THEN 'allowed'
          ELSE CASE WHEN ${screeningEnabled} THEN 'held' ELSE 'allowed' END
        END AS status
      FROM messages m
      LEFT JOIN LATERAL effective_sender_decision(m.user_id, m.from_address) d ON true
      WHERE m.user_id = ${userId} AND NOT m.is_sent AND NOT m.is_deleted
        AND (lower(btrim(m.from_address)) = ${exact} OR (${domain} <> '' AND (
          regexp_replace(lower(btrim(m.from_address)), '^.*@', '') = ${domain}
          OR right(regexp_replace(lower(btrim(m.from_address)), '^.*@', ''), length(${suffix})) = ${suffix})))
        AND (m.screening_status <> 'allowed' OR (${action === 'block'} AND m.id = ${messageId}::uuid))
    ) scoped
    WHERE target.id = scoped.id AND target.user_id = ${userId}
    RETURNING target.id, target.thread_id, lower(btrim(target.from_address)) AS address`;
}
