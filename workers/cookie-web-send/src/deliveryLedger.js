// Provider delivery and local history are separate durable outcomes. No
// transaction spans network I/O, and every retry uses the first frozen payload.
export const DELIVERY_LEASE_MS = 120_000;
export const DELIVERY_MAX_ATTEMPTS = 5;

export class DeliveryError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(
      code === 'DELIVERY_UNCERTAIN'
        ? 'Delivery needs confirmation before retrying'
        : code === 'DELIVERY_CONFLICT'
          ? 'Request id already used for a different email'
          : code === 'DELIVERY_REJECTED'
            ? 'The email provider rejected this delivery'
            : 'Delivery is being confirmed. Retry the same request shortly.',
    );
    this.code = code;
  }
}

/** @param {any} sql @param {string} userId @param {string} key @param {string | null} [requestId] */
export async function findDelivery(sql, userId, key, requestId = null) {
  const [row] = await sql`SELECT * FROM outbound_deliveries
    WHERE user_id = ${userId}
      AND (source_key = ${key} OR (${requestId}::text IS NOT NULL AND request_id = ${requestId}))
    LIMIT 1`;
  if (row && row.source_key !== key) throw new DeliveryError('DELIVERY_CONFLICT');
  return row ?? null;
}

/** @param {any} sql @param {string} userId @param {string} key @param {any} payload @param {any} copy @param {string | null} requestId */
export async function createDelivery(sql, userId, key, payload, copy, requestId) {
  return sql.begin(async (/** @type {any} */ tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${requestId ?? key}`}, 4))`;
    const existing = await findDelivery(tx, userId, key, requestId);
    if (existing) return existing;
    const uploads = (copy.attachments ?? [])
      .filter((/** @type {any} */ attachment) => attachment.source === 'upload')
      .map((/** @type {any} */ attachment) => attachment.id);
    const inbound = (copy.attachments ?? [])
      .filter((/** @type {any} */ attachment) => attachment.source !== 'upload')
      .map((/** @type {any} */ attachment) => attachment.id);
    // Hold source rows until the snapshot is visible to object cleanup.
    // A concurrent hard-delete must not remove the final storage reference
    // between attachment validation and recording the durable intent.
    if (uploads.length) {
      const locked = await tx`SELECT id FROM outbound_attachments
        WHERE user_id = ${userId} AND id = ANY(${uploads}::uuid[]) FOR KEY SHARE`;
      if (locked.length !== uploads.length) throw new Error('An attachment is no longer available');
    }
    if (inbound.length) {
      const locked = await tx`SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id
        WHERE m.user_id = ${userId} AND a.id = ANY(${inbound}::uuid[]) FOR KEY SHARE OF a`;
      if (locked.length !== inbound.length) throw new Error('An attachment is no longer available');
    }
    const [row] = await tx`INSERT INTO outbound_deliveries
      (user_id, source_key, request_id, provider_payload, copy_payload)
      VALUES (${userId}, ${key}, ${requestId}, ${tx.json(payload)}, ${tx.json(copy)})
      RETURNING *`;
    if (uploads.length) {
      // The FK prevents a concurrent upload-delete from taking the bytes
      // between this commit and provider dispatch.
      await tx`INSERT INTO outbound_delivery_uploads (delivery_id, outbound_attachment_id)
        SELECT ${row.id}, id FROM outbound_attachments
        WHERE user_id = ${userId} AND id = ANY(${uploads}::uuid[])`;
      const [count] = await tx`SELECT count(*)::int AS count FROM outbound_delivery_uploads
        WHERE delivery_id = ${row.id}`;
      if (count.count !== uploads.length) throw new Error('An attachment is no longer available');
    }
    return row;
  });
}

/** @param {any} sql @param {any} delivery */
export async function claimDelivery(sql, delivery) {
  const result = await sql.begin(async (/** @type {any} */ tx) => {
    const [row] = await tx`SELECT *, clock_timestamp() AS clock FROM outbound_deliveries
      WHERE id = ${delivery.id} AND user_id = ${delivery.user_id} FOR UPDATE`;
    if (!row) throw new Error('Delivery record is unavailable');
    if (row.provider_id) return { row, send: false };
    if (row.status === 'uncertain') return { error: 'DELIVERY_UNCERTAIN' };
    if (row.status === 'rejected') return { error: 'DELIVERY_REJECTED' };
    const now = new Date(row.clock).getTime();
    if (row.claimed_at && new Date(row.claimed_at).getTime() > now - DELIVERY_LEASE_MS) {
      return { error: 'DELIVERY_PENDING' };
    }
    if (
      (row.retry_until && new Date(row.retry_until).getTime() <= now) ||
      row.attempts >= DELIVERY_MAX_ATTEMPTS
    ) {
      await tx`UPDATE outbound_deliveries SET status = 'uncertain',
        claimed_at = NULL, claim_token = NULL, last_error = 'confirmation_window_ended',
        updated_at = now() WHERE id = ${row.id}`;
      return { error: 'DELIVERY_UNCERTAIN' };
    }
    const [claimed] = await tx`UPDATE outbound_deliveries SET status = 'sending',
      attempts = attempts + 1, claimed_at = clock_timestamp(), claim_token = ${crypto.randomUUID()},
      first_attempt_at = coalesce(first_attempt_at, ${row.clock}::timestamptz),
      retry_until = coalesce(retry_until, ${row.clock}::timestamptz + interval '23 hours'),
      updated_at = now()
      WHERE id = ${row.id} RETURNING *`;
    return { row: claimed, send: true };
  });
  // Throw after commit, otherwise the terminal uncertainty update rolls back.
  if (result.error) throw new DeliveryError(result.error);
  return result;
}

/** @param {any} sql @param {any} row @param {string} providerId */
export async function acceptDelivery(sql, row, providerId) {
  const [accepted] = await sql`UPDATE outbound_deliveries SET
    status = 'accepted', provider_id = ${providerId},
    accepted_at = coalesce(accepted_at, clock_timestamp()),
    claimed_at = NULL, claim_token = NULL, last_error = NULL, updated_at = now()
    WHERE id = ${row.id} AND user_id = ${row.user_id}
      AND (provider_id IS NULL OR provider_id = ${providerId}) RETURNING *`;
  if (!accepted) throw new Error('Delivery confirmation could not be recorded');
  return accepted;
}

/** @param {any} sql @param {any} row @param {string} outcome */
export async function deferDelivery(sql, row, outcome) {
  const status =
    outcome === 'uncertain' || (outcome === 'rejected' && row.attempts > 1)
      ? 'uncertain'
      : outcome === 'rejected'
        ? 'rejected'
        : 'sending';
  await sql.begin(async (/** @type {any} */ tx) => {
    await tx`UPDATE outbound_deliveries SET status = ${status},
      claimed_at = NULL, claim_token = NULL, last_error = ${outcome}, updated_at = now()
      WHERE id = ${row.id} AND claim_token = ${row.claim_token} AND provider_id IS NULL`;
    if (status === 'rejected') {
      await tx`DELETE FROM outbound_delivery_uploads WHERE delivery_id = ${row.id}
        AND EXISTS (SELECT 1 FROM outbound_deliveries WHERE id = ${row.id} AND status = 'rejected')`;
      await tx`UPDATE outbound_deliveries SET provider_payload = '{}'::jsonb, copy_payload = '{}'::jsonb
        WHERE id = ${row.id} AND status = 'rejected'`;
    }
  });
  return status;
}

/** @param {any} sql @param {any} row @param {string} messageId */
export async function completeDelivery(sql, row, messageId) {
  await sql.begin(async (/** @type {any} */ tx) => {
    await tx`UPDATE outbound_deliveries SET status = 'complete', sent_message_id = ${messageId},
      provider_payload = '{}'::jsonb,
      copy_payload = jsonb_build_object('followUpAt', copy_payload->'followUpAt'),
      updated_at = now(), last_error = NULL WHERE id = ${row.id} AND user_id = ${row.user_id}`;
    await tx`DELETE FROM outbound_delivery_uploads WHERE delivery_id = ${row.id}`;
    if (row.source_key.startsWith('scheduled-send/')) {
      await tx`UPDATE scheduled_sends SET status = 'sent', sent_message_id = ${messageId},
        sent_at = coalesce(sent_at, ${row.accepted_at}::timestamptz), claimed_at = NULL, last_error = NULL
        WHERE id = ${row.source_key.slice('scheduled-send/'.length)}::uuid AND user_id = ${row.user_id}`;
    }
  });
}

/** @param {any} sql @param {any} row */
export async function deferCopyRepair(sql, row) {
  await sql`UPDATE outbound_deliveries SET updated_at = now(), last_error = 'sent_copy_pending'
    WHERE id = ${row.id} AND status = 'accepted'`;
}

/** @param {any} sql @param {string} userId @param {string} key */
export async function stopUnconfirmedDelivery(sql, userId, key) {
  await sql`UPDATE outbound_deliveries SET status = 'uncertain',
    claimed_at = NULL, claim_token = NULL, last_error = 'confirmation_required', updated_at = now()
    WHERE user_id = ${userId} AND source_key = ${key}
      AND provider_id IS NULL AND status IN ('pending', 'sending')`;
}
