// Ported from Cookie-Web's api/_lib/calendars.js. Behaviorally identical —
// same queries, validation, migration-window fallbacks, and status codes;
// only the (req, res) mutation style becomes returning a Response, and the
// ?resource=calendars multiplexing becomes this Worker's own /calendars
// route.

import { allowRequest } from '../../../shared/rate-limit.js';
import {
  calendarSubscriptionAllowlist,
  syncCalendarSubscription,
  validSubscriptionUrl,
} from './calendarSync.js';
import { validId } from '../../../shared/pagination.js';
import { isGoogleConfigured, loadConnectionIfAvailable } from './googleAuth.js';
import { googleCalendarEntries, googleCalendarKey } from './googleCalendar.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_NAME = 50;
// A subscription sync performs a server-side HTTPS fetch (10s timeout, 5MB
// cap) plus a transactional rewrite of up to 1000 event rows, so both the
// create-time initial sync and manual re-syncs share one per-user quota.
const SYNC_RATE_LIMIT = { limit: 5, windowMs: 60_000 };
// Subscribed feeds are refreshed lazily: GET /calendars starts a background
// refresh of the feeds last synced longer ago than this, the stalest first and
// at most a couple per request, under the same per-user sync quota.
const SUBSCRIPTION_REFRESH_MS = 12 * 60 * 60 * 1000;
const MAX_LAZY_REFRESHES = 2;

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

// fetchCalendars' rows together with the saved default calendar id
// (users.prefs, see readDefaultCalendarId), which GET /calendars reports
// beside them: one read instead of two. Anchored on the user so the id comes
// back even when there are no calendars yet. `defaultId` is null when none is
// saved.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @returns {Promise<{calendars: any[], defaultId: string | null}>}
 */
async function fetchCalendarsAndDefault(sql, userId) {
  const rows = await sql`
    SELECT c.id, c.name, c.color, c.subscription_url AS "subscriptionUrl",
           c.subscription_synced_at AS "subscriptionSyncedAt", c.subscription_error AS "subscriptionError",
           u.prefs ->> 'defaultCalendarId' AS "defaultCalendarId"
    FROM users u
    LEFT JOIN calendars c ON c.user_id = u.id
    WHERE u.id = ${userId}
    ORDER BY c.created_at, c.id
  `;
  return {
    calendars: rows
      .filter((row) => row.id !== null)
      .map(({ defaultCalendarId: _defaultCalendarId, ...calendar }) => calendar),
    defaultId: rows[0]?.defaultCalendarId ?? null,
  };
}

// New users have no calendars until this runs once; seed the same five
// defaults the client used to hardcode so the sidebar isn't empty on first
// load. A no-op for anyone who already has calendars, including users
// backfilled by migration 0023.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any[]} existing The calendars the caller has just read.
 */
async function ensureDefaultCalendars(sql, userId, existing) {
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
 * Stored calendars first, then the Google calendars the person chose to show
 * (googleCalendar.js), which the sidebar and event dialog treat alike.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').CalendarEnv} [env]
 */
/**
 * The subscribed calendars due a refresh, stalest (or never synced) first.
 *
 * @param {{id: string, subscriptionUrl?: string | null, subscriptionSyncedAt?: Date | string | null}[]} calendars
 * @param {number} now
 */
function staleSubscriptions(calendars, now) {
  const syncedAt = (/** @type {{subscriptionSyncedAt?: Date | string | null}} */ calendar) =>
    calendar.subscriptionSyncedAt ? new Date(calendar.subscriptionSyncedAt).getTime() : 0;
  return calendars
    .filter(
      (calendar) => calendar.subscriptionUrl && now - syncedAt(calendar) > SUBSCRIPTION_REFRESH_MS,
    )
    .sort((a, b) => syncedAt(a) - syncedAt(b))
    .slice(0, MAX_LAZY_REFRESHES);
}

/**
 * Background refresh started by GET /calendars. Claims one unit of the sync
 * quota for the batch and does nothing when none is left; a feed that fails
 * records its error as a manual sync would.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{id: string, subscriptionUrl?: string | null}[]} calendars
 * @param {import('./sentry.js').CalendarEnv} env
 * @param {typeof syncCalendarSubscription} [sync]
 */
export async function refreshSubscriptions(
  sql,
  userId,
  calendars,
  env,
  sync = syncCalendarSubscription,
) {
  if (await claimSyncQuota(sql, userId)) return;
  const allowlist = calendarSubscriptionAllowlist(env);
  for (const calendar of calendars) {
    // Re-validated like a manual sync, so a host no longer allowed is skipped.
    const url = validSubscriptionUrl(calendar.subscriptionUrl, allowlist);
    if (url) await sync(sql, calendar.id, userId, url);
  }
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').CalendarEnv} [env]
 * @param {{
 *   defer?: (task: (sql: import('postgres').Sql) => Promise<void>) => void,
 *   now?: () => number,
 *   sync?: typeof syncCalendarSubscription,
 * }} [options] `defer` runs a task after the response on its own database
 *   client; without it, stale subscriptions are left alone.
 */
export async function listCalendars(sql, userId, env = /** @type {any} */ ({}), options = {}) {
  let calendars;
  // Stays undefined when the one read below could not run, and the saved
  // default is then read on its own, as it always used to be.
  /** @type {string | null | undefined} */
  let defaultId;
  try {
    let existing;
    try {
      ({ calendars: existing, defaultId } = await fetchCalendarsAndDefault(sql, userId));
    } catch (error) {
      // Before migration 0026 the subscription columns are missing;
      // fetchCalendars knows how to read without them.
      if (/** @type {{code?: string}} */ (error)?.code !== '42703') throw error;
      existing = await fetchCalendars(sql, userId);
    }
    calendars = await ensureDefaultCalendars(sql, userId, existing);
  } catch (error) {
    // The Workers and migration pipelines deploy independently. Keep the new
    // client usable if it arrives first; mutations become available as soon
    // as the expand migration creates the table.
    if (!isUndefinedTable(error)) throw error;
    calendars = DEFAULT_CALENDARS;
  }
  const stale = options.defer ? staleSubscriptions(calendars, (options.now ?? Date.now)()) : [];
  if (stale.length) {
    options.defer?.((background) =>
      refreshSubscriptions(background, userId, stale, env, options.sync),
    );
  }
  if (isGoogleConfigured(env)) {
    calendars = [
      ...calendars,
      ...googleCalendarEntries(await loadConnectionIfAvailable(sql, userId)),
    ];
  }
  if (defaultId === undefined) defaultId = await readDefaultCalendarId(sql, userId);
  return Response.json({
    calendars,
    defaultCalendarId: writableDefaultCalendarId(defaultId, calendars),
  });
}

// The person's chosen destination for new events, kept in users.prefs like
// the other per-user settings. GET /calendars normally reads it with the
// calendars (fetchCalendarsAndDefault); this is the read on its own, for when
// that one could not run.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @returns {Promise<string | null>}
 */
async function readDefaultCalendarId(sql, userId) {
  const [row] = await sql`
    SELECT prefs ->> 'defaultCalendarId' AS id FROM users WHERE id = ${userId}
  `;
  return row?.id ?? null;
}

// The saved default is reported only while it still names one of the
// calendars an event can be filed in; a deleted, unsubscribed-from or now
// read-only calendar silently drops back to the client's own fallback.
/**
 * @param {string | null} saved
 * @param {{id: string, subscriptionUrl?: string | null, readOnly?: boolean}[]} calendars
 */
function writableDefaultCalendarId(saved, calendars) {
  const id = String(saved ?? '');
  return id && calendars.some((calendar) => calendar.id === id && isWritable(calendar)) ? id : null;
}

/** @param {{subscriptionUrl?: string | null, readOnly?: boolean}} calendar */
const isWritable = (calendar) => !calendar.subscriptionUrl && !calendar.readOnly;

// PATCH /calendars with `defaultCalendarId`: null clears the choice, otherwise
// it must be one of the person's own calendars or a selected Google calendar
// they can write to.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {import('./sentry.js').CalendarEnv} env
 */
export async function setDefaultCalendar(sql, userId, body, env = /** @type {any} */ ({})) {
  if (body.defaultCalendarId === null) {
    await sql`
      UPDATE users SET prefs = coalesce(prefs, '{}'::jsonb) - 'defaultCalendarId'
      WHERE id = ${userId}
    `;
    return Response.json({ defaultCalendarId: null });
  }

  const id = String(body.defaultCalendarId ?? '');
  const isGoogle = id.startsWith('google:');
  if (!id || (!isGoogle && !validId(id))) {
    return Response.json(
      { error: 'defaultCalendarId must be a calendar id or null' },
      { status: 400 },
    );
  }

  // Saved in the form GET /calendars lists it: Postgres lowercases a UUID it
  // accepted in upper case, and the read side compares ids as strings.
  const stored = isGoogle
    ? (await isWritableGoogleCalendar(sql, userId, id, env))
      ? id
      : null
    : await ownCalendarId(sql, userId, id);
  if (!stored) {
    return Response.json({ error: 'Calendar not found or not writable' }, { status: 404 });
  }

  await sql`
    UPDATE users
    SET prefs = coalesce(prefs, '{}'::jsonb) || ${sql.json({ defaultCalendarId: stored })}
    WHERE id = ${userId}
  `;
  return Response.json({ defaultCalendarId: stored });
}

// The canonical id of one of the person's own (not subscribed) calendars.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 */
async function ownCalendarId(sql, userId, id) {
  const [row] = await sql`
    SELECT c.id FROM calendars c
    WHERE c.id = ${id} AND c.user_id = ${userId} AND c.subscription_url IS NULL
  `;
  return row ? String(row.id) : null;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @param {import('./sentry.js').CalendarEnv} env
 */
async function isWritableGoogleCalendar(sql, userId, id, env) {
  if (!isGoogleConfigured(env)) return false;
  const connection = await loadConnectionIfAvailable(sql, userId);
  return Boolean(
    connection?.selectedCalendars.some(
      (calendar) => googleCalendarKey(calendar.id) === id && !calendar.readOnly,
    ),
  );
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
 * @param {import('./sentry.js').CalendarEnv} env
 * @param {typeof syncCalendarSubscription} [sync]
 */
export async function createCalendar(sql, userId, body, env, sync = syncCalendarSubscription) {
  const name = validName(body.name);
  const color = String(body.color ?? '');
  const subscriptionUrl =
    body.subscriptionUrl !== undefined &&
    body.subscriptionUrl !== null &&
    body.subscriptionUrl !== ''
      ? validSubscriptionUrl(body.subscriptionUrl, calendarSubscriptionAllowlist(env))
      : null;
  if (!name || !COLOR_RE.test(color) || (body.subscriptionUrl && !subscriptionUrl)) {
    return Response.json(
      {
        error:
          'name (max 50), a hex color, and (if subscribing) a valid https:// or webcal:// calendar URL are required',
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
      subscriptionError: result.ok ? (result.warning ?? null) : result.error,
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
 * @param {import('./sentry.js').CalendarEnv} env
 * @param {typeof syncCalendarSubscription} [sync]
 */
export async function syncCalendar(sql, userId, body, env, sync = syncCalendarSubscription) {
  const id = validId(body.id) ? String(body.id) : null;
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

  // Re-validate stored URLs against the current allowlist so a policy change
  // or newly-disallowed host cannot be used via an old subscription. Sync the
  // normalized form rather than the stored one, so a subscription saved before
  // a rewrite existed (e.g. a Google share link) recovers on "Sync now".
  const url = validSubscriptionUrl(row.subscriptionUrl, calendarSubscriptionAllowlist(env));
  if (!url) {
    return Response.json(
      { error: 'Calendar subscription URL is no longer allowed' },
      { status: 400 },
    );
  }

  const result = await sync(sql, row.id, row.userId, url);
  return Response.json(
    result.ok
      ? {
          ok: true,
          subscriptionSyncedAt: new Date().toISOString(),
          subscriptionError: result.warning ?? null,
        }
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
  const id = validId(body.id) ? String(body.id) : null;
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
  const id = validId(body.id) ? String(body.id) : null;
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
