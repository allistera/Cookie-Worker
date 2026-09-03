// How long spam is kept before the mail-app-ingest cron soft-deletes it
// (workers/mail-app-ingest/src/spamRetentionSweep.js). Lives in users.prefs
// like AI Today's interests: the sweep reads it with no browser running.
export const DEFAULT_SPAM_RETENTION_DAYS = 30;
export const MIN_SPAM_RETENTION_DAYS = 1;
export const MAX_SPAM_RETENTION_DAYS = 365;

/**
 * Coerces a stored or submitted value to a whole number of days within
 * bounds. Returns null for anything that is not a finite number, which the
 * PUT handler reports as a 400 and the GET handler treats as "unset".
 * @param {unknown} value
 */
export function normalizeSpamRetentionDays(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const days = Math.floor(value);
  if (days < MIN_SPAM_RETENTION_DAYS || days > MAX_SPAM_RETENTION_DAYS) return null;
  return days;
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export function fetchSpamRetentionDays(sql, userId) {
  return sql`
    SELECT u.prefs -> 'spamRetentionDays' AS days
    FROM users u
    WHERE u.id = ${userId}
  `;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {number} days */
export function saveSpamRetentionDays(sql, userId, days) {
  // sql.json, never a pre-stringified string: see interests.js in the tasks
  // Worker — a string parameter becomes a jsonb scalar and the || below would
  // append instead of merging keys, dropping every other preference.
  return sql`
    UPDATE users
    SET prefs = coalesce(prefs, '{}'::jsonb) || ${sql.json({ spamRetentionDays: days })}
    WHERE id = ${userId}
    RETURNING prefs -> 'spamRetentionDays' AS days
  `;
}

/** @param {unknown} stored */
function responseFor(stored) {
  return Response.json({
    spamRetentionDays: normalizeSpamRetentionDays(stored) ?? DEFAULT_SPAM_RETENTION_DAYS,
    defaultDays: DEFAULT_SPAM_RETENTION_DAYS,
    minDays: MIN_SPAM_RETENTION_DAYS,
    maxDays: MAX_SPAM_RETENTION_DAYS,
  });
}

// GET /emails/spam-retention — the stored preference, or the default when
// the user has never changed it (or the stored value is out of bounds).
/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getSpamRetention(sql, userId) {
  const [row] = await fetchSpamRetentionDays(sql, userId);
  return responseFor(row?.days);
}

// PUT /emails/spam-retention — {spamRetentionDays: 1..365}.
/** @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
export async function putSpamRetention(sql, userId, body) {
  const days = normalizeSpamRetentionDays(body?.spamRetentionDays);
  if (days === null) {
    return Response.json(
      {
        error: `spamRetentionDays must be a number of days from ${MIN_SPAM_RETENTION_DAYS} to ${MAX_SPAM_RETENTION_DAYS}`,
      },
      { status: 400 },
    );
  }
  const [row] = await saveSpamRetentionDays(sql, userId, days);
  if (!row) return Response.json({ error: 'User not found' }, { status: 404 });
  return responseFor(row.days);
}
