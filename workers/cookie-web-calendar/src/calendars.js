// Ported from Cookie-Web's api/_lib/calendars.js. Behaviorally identical —
// same queries, validation, migration-window fallbacks, and status codes;
// only the (req, res) mutation style becomes returning a Response, and the
// ?resource=calendars multiplexing becomes this Worker's own /calendars
// route.

import { allowRequest } from '../../../shared/rate-limit.js';
import { syncCalendarSubscription, validSubscriptionUrl } from './calendarSync.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_NAME = 50;
// A subscription sync performs a server-side HTTPS fetch (10s timeout, 5MB
// cap) plus a transactional rewrite of up to 1000 event rows, so both the
// create-time initial sync and manual re-syncs share one per-user quota.
const SYNC_RATE_LIMIT = { limit: 5, windowMs: 60_000 };

const DEFAULT_CALENDARS = [
  { id: 'work', name: 'Work', color: '#4f7c6b' },
  { id: 'personal', name: 'Personal', color: '#2db985' },
  { id: 'focus', name: 'Focus time', color: '#795da8' },
  { id: 'birthdays', name: 'Birthdays', color: '#d8953b' },
  { id: 'holidays', name: 'Holidays', color: '#d15c4e' },
];

/** @param {unknown} error */
export const isUndefinedTable = (error) => /** @type {{code?: string}} */ (error)?.code === '42P01';

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function fetchCalendars(sql, userId) {
  try {
    return await sql`
      SELECT c.id, c.name, c.color, c.subscription_url AS "subscriptionUrl",
             c.subscription_synced_at AS "subscriptionSyncedAt", c.subscription_error AS "subscriptionError"
      FROM calendars c
      WHERE c.user_id = ${userId}
      ORDER BY c.created_at, c.id
    `;
  } catch (error) {
    // During the rollout window before migration 0026 lands, fall back to a
    // read that doesn't reference the new subscription columns.
    if (/** @type {{code?: string}} */ (error)?.code !== '42703') throw error;
    return sql`
      SELECT c.id, c.name, c.color
      FROM calendars c
      WHERE c.user_id = ${userId}
      ORDER BY c.created_at, c.id
    `;
  }
}

// New users have no calendars until this runs once; seed the same five
// defaults the client used to hardcode so the sidebar isn't empty on first
// load. A no-op for anyone who already has calendars, including users
// backfilled by migration 0023.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
async function ensureDefaultCalendars(sql, userId) {
  const existing = await fetchCalendars(sql, userId);
  if (existing.length > 0) return existing;

  // Seed in one statement, then read the canonical rows. This avoids leaving
  // a permanently partial set after a mid-loop failure and makes concurrent
  // first loads return the same complete result. WHERE EXISTS keeps the same
  // no-op-if-the-user-vanished behavior the users-join used to give for free.
  await sql`
    INSERT INTO calendars (user_id, name, color)
    SELECT ${userId}, defaults.name, defaults.color
    FROM (VALUES
      ('Work', '#4f7c6b'),
      ('Personal', '#2db985'),
      ('Focus time', '#795da8'),
      ('Birthdays', '#d8953b'),
      ('Holidays', '#d15c4e')
    ) AS defaults(name, color)
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
    ON CONFLICT (user_id, name) DO NOTHING
  `;
  return fetchCalendars(sql, userId);
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function listCalendars(sql, userId) {
  let calendars;
  try {
    calendars = await ensureDefaultCalendars(sql, userId);
  } catch (error) {
    // The Workers and migration pipelines deploy independently. Keep the new
    // client usable if it arrives first; mutations become available as soon
    // as the expand migration creates the table.
    if (!isUndefinedTable(error)) throw error;
    calendars = DEFAULT_CALENDARS;
  }
  return Response.json({ calendars });
}

/** @param {unknown} name */
function validName(name) {
  const trimmed = String(name ?? '').trim();
  return trimmed && trimmed.length <= MAX_NAME ? trimmed : null;
}

/**
 * Claims the shared per-user sync quota. Returns null when allowed, or the
 * refusal Response to send.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function claimSyncQuota(sql, userId) {
  let allowed;
  try {
    allowed = await allowRequest(sql, userId, 'calendar-sync', SYNC_RATE_LIMIT);
  } catch (err) {
    console.error('calendar sync quota enforcement failed:', /** @type {Error} */ (err).message);
    return Response.json({ error: 'Calendar sync is temporarily unavailable' }, { status: 503 });
  }
  if (!allowed) {
    return Response.json({ error: 'Too many calendar syncs, slow down' }, { status: 429 });
  }
  return null;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {typeof syncCalendarSubscription} [sync]
 */
export async function createCalendar(sql, userId, body, sync = syncCalendarSubscription) {
  const name = validName(body.name);
  const color = String(body.color ?? '');
  const subscriptionUrl =
    body.subscriptionUrl !== undefined &&
    body.subscriptionUrl !== null &&
    body.subscriptionUrl !== ''
      ? validSubscriptionUrl(body.subscriptionUrl)
      : null;
  if (!name || !COLOR_RE.test(color) || (body.subscriptionUrl && !subscriptionUrl)) {
    return Response.json(
      {
        error:
          'name (max 50), a hex color, and (if subscribing) a valid https calendar URL are required',
      },
      { status: 400 },
    );
  }

  const [row] = await sql`
    INSERT INTO calendars (user_id, name, color, subscription_url)
    SELECT ${userId}, ${name}, ${color}, ${subscriptionUrl}
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
    ON CONFLICT (user_id, name) DO NOTHING
    RETURNING id, name, color, user_id AS "userId"
  `;
  if (!row) {
    return Response.json({ error: 'A calendar with that name already exists' }, { status: 409 });
  }

  let calendar = { id: row.id, name: row.name, color: row.color };
  if (subscriptionUrl) {
    const result = await sync(sql, row.id, row.userId, subscriptionUrl);
    calendar = {
      ...calendar,
      subscriptionUrl,
      subscriptionSyncedAt: result.ok ? new Date().toISOString() : null,
      subscriptionError: result.ok ? null : result.error,
    };
  }
  return Response.json({ calendar }, { status: 201 });
}

// Manual re-sync of an existing subscribed calendar, triggered from the
// sidebar's "Sync now" action.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {typeof syncCalendarSubscription} [sync]
 */
export async function syncCalendar(sql, userId, body, sync = syncCalendarSubscription) {
  const id = UUID_RE.test(body.id) ? String(body.id) : null;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }

  const [row] = await sql`
    SELECT c.id, c.user_id AS "userId", c.subscription_url AS "subscriptionUrl"
    FROM calendars c
    WHERE c.id = ${id} AND c.user_id = ${userId}
  `;
  if (!row?.subscriptionUrl) {
    return Response.json({ error: 'Subscribed calendar not found' }, { status: 404 });
  }

  const result = await sync(sql, row.id, row.userId, row.subscriptionUrl);
  return Response.json(
    result.ok
      ? { ok: true, subscriptionSyncedAt: new Date().toISOString(), subscriptionError: null }
      : { ok: false, subscriptionError: result.error },
    { status: result.ok ? 200 : 502 },
  );
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function renameCalendar(sql, userId, body) {
  const id = UUID_RE.test(body.id) ? String(body.id) : null;
  const name = id ? validName(body.name) : null;
  if (!id || !name) {
    return Response.json({ error: 'id and a valid name (max 50) are required' }, { status: 400 });
  }

  let calendar;
  try {
    [calendar] = await sql`
      UPDATE calendars c
      SET name = ${name}
      WHERE c.id = ${id} AND c.user_id = ${userId}
      RETURNING c.id, c.name, c.color
    `;
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === '23505') {
      return Response.json({ error: 'A calendar with that name already exists' }, { status: 409 });
    }
    throw error;
  }

  if (!calendar) {
    return Response.json({ error: 'Calendar not found' }, { status: 404 });
  }
  return Response.json({ calendar });
}

// Blocks deleting a manually-managed calendar that still has events, rather
// than silently cascading the delete or orphaning them — the client asks the
// user to delete or move those events first. Subscribed calendars are
// exempt: their events are entirely sync-owned (never hand-edited), so
// deleting the subscription cascades its events rather than asking the user
// to clear a calendar they can't otherwise edit.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function deleteCalendar(sql, userId, body) {
  const id = UUID_RE.test(body.id) ? String(body.id) : null;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }

  let owned;
  try {
    [owned] = await sql`
      SELECT c.subscription_url IS NOT NULL AS "isSubscribed"
      FROM calendars c
      WHERE c.id = ${id} AND c.user_id = ${userId}
    `;
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== '42703') throw error;
    // Rollout window before migration 0026 lands: no calendar can be a
    // subscription yet, so behave exactly like the pre-subscription check.
    [owned] = await sql`
      SELECT false AS "isSubscribed"
      FROM calendars c
      WHERE c.id = ${id} AND c.user_id = ${userId}
    `;
  }
  if (!owned) {
    return Response.json({ error: 'Calendar not found' }, { status: 404 });
  }

  // user_id rides along in these statements not for authorization (the
  // ownership check above already settled that) but so the composite index
  // (user_id, calendar) applies — calendar alone has no usable index.
  if (owned.isSubscribed) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM calendar_events WHERE user_id = ${userId} AND calendar = ${id}`;
      await tx`DELETE FROM calendars WHERE id = ${id}`;
    });
    return Response.json({ ok: true });
  }

  const [{ count }] = await sql`
    SELECT count(*)::int AS count
    FROM calendar_events WHERE user_id = ${userId} AND calendar = ${id}
  `;
  if (count > 0) {
    return Response.json(
      {
        error: `This calendar has ${count} event${count === 1 ? '' : 's'}. Delete or move them first.`,
      },
      { status: 409 },
    );
  }

  try {
    await sql`DELETE FROM calendars WHERE id = ${id}`;
  } catch (error) {
    // The FK installed by the contract migration closes the count/delete
    // race if an event is created between the two statements.
    if (/** @type {{code?: string}} */ (error)?.code === '23503') {
      return Response.json(
        { error: 'This calendar has events. Delete or move them first.' },
        { status: 409 },
      );
    }
    throw error;
  }
  return Response.json({ ok: true });
}
