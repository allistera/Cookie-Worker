import {
  lockOutOfOfficeDispatch,
  outOfOfficeError,
  outOfOfficeSettings,
  outOfOfficeStatus,
} from '../../../shared/outOfOffice.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getOutOfOffice(sql, userId) {
  const [owner] =
    await sql`SELECT prefs -> 'outOfOffice' AS settings FROM users WHERE id = ${userId}`;
  if (!owner) return reply({ error: 'User not found' }, 404);
  const settings = outOfOfficeSettings(owner.settings);
  const review = await sql`
    SELECT id, recipient, status, reason, created_at, first_attempt_at
    FROM out_of_office_deliveries
    WHERE user_id = ${userId} AND status IN ('uncertain', 'failed') AND resolved_at IS NULL
    ORDER BY created_at DESC LIMIT 20
  `;
  return reply({ ...settings, status: outOfOfficeStatus(settings), review });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
export async function putOutOfOffice(sql, userId, body) {
  if (body?.action === 'resolve') return resolveDelivery(sql, userId, body);
  const stopping = body?.action === 'stop';
  if (!stopping) {
    const error = outOfOfficeError(body);
    if (error) return reply({ error }, 400);
  }
  const outcome = await sql.begin(async (tx) => {
    // Wait for dispatch before borrowing any lock needed by ingest. Once this
    // lock is held, the short owner-locked write stays atomic with arrival
    // snapshots and activation time without holding up inbound provider I/O.
    await lockOutOfOfficeDispatch(tx, userId);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
    const [owner] = await tx`SELECT prefs -> 'outOfOffice' AS settings
      FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!owner) return reply({ error: 'User not found' }, 404);
    const current = outOfOfficeSettings(owner.settings);
    if (!stopping && current.revision !== body.revision)
      return reply(
        { error: 'Out-of-office settings changed. Reload and review before saving.', current },
        409,
      );
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    const next = stopping
      ? { ...current, revision: current.revision + 1, enabled: false, activatedAt: null }
      : {
          revision: current.revision + 1,
          enabled: body.enabled,
          startDate: body.startDate,
          endDate: body.endDate,
          timeZone: body.timeZone,
          subject: body.subject,
          text: body.text,
          activatedAt: body.enabled ? new Date(clock.now).toISOString() : null,
        };
    await tx`UPDATE users SET prefs = jsonb_set(coalesce(prefs, '{}'::jsonb), '{outOfOffice}', ${tx.json(next)}, true)
      WHERE id = ${userId}`;
    return null;
  });
  return outcome ?? getOutOfOffice(sql, userId);
}

/** Manual resolution never sends or retries mail. @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
async function resolveDelivery(sql, userId, body) {
  if (
    !UUID_RE.test(String(body.deliveryId)) ||
    !['delivered', 'not_delivered'].includes(body.outcome)
  )
    return reply({ error: 'Choose a delivery and a verified outcome.' }, 400);
  const changed = await sql.begin(async (tx) => {
    await lockOutOfOfficeDispatch(tx, userId);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const [row] = await tx`UPDATE out_of_office_deliveries
      SET status = ${body.outcome === 'delivered' ? 'sent' : 'failed'}, resolved_at = clock_timestamp(),
          reason = ${body.outcome === 'delivered' ? 'manually_confirmed' : 'manually_not_delivered'},
          sent_at = CASE WHEN ${body.outcome === 'delivered'} THEN clock_timestamp() ELSE sent_at END
      WHERE id = ${body.deliveryId} AND user_id = ${userId}
        AND status IN ('uncertain', 'failed') AND resolved_at IS NULL
      RETURNING id`;
    if (!row) return false;
    await tx`UPDATE out_of_office_senders SET blocked = false,
      next_allowed_at = CASE WHEN ${body.outcome === 'delivered'} THEN clock_timestamp() + interval '4 days' ELSE clock_timestamp() END
      WHERE user_id = ${userId} AND delivery_id = ${row.id}`;
    return true;
  });
  return changed
    ? getOutOfOffice(sql, userId)
    : reply({ error: 'Delivery is not awaiting review.' }, 404);
}
