import { endSql } from '../../../shared/db.js';
import { fetchWithTimeout } from '../../../shared/fetch.js';
import { captureHandledException, captureInboundHealthIssue } from './sentry.js';

// Inbound mail stopped for about 20 hours after the catch-all Email Routing rule
// changed on 2026-10-22, and nothing alerted. These checks look at stored
// metadata and the routing configuration only; they never read message content.

// Default for INBOUND_STALE_HOURS. Over 120 days the p99 gap between inbound rows
// was 6.4 hours, and gaps of 16.7, 17.9 and 20.4 hours occurred. 12 hours is a
// deliberate default: it sits well above the p99, so ordinary quiet stretches
// rarely alert, while an outage is still caught within half a day. The three
// longer natural gaps would each have alerted; that trade-off is accepted, and
// the variable overrides it.
export const DEFAULT_INBOUND_STALE_HOURS = 12;

// Default for PENDING_ENRICHMENT_MAX_MINUTES. Classification normally completes
// within minutes, and the recovery cron retries every 15 minutes, so a row still
// pending after an hour means the retries are not working (a missing key, an
// exhausted budget, or an OpenAI outage).
export const DEFAULT_PENDING_ENRICHMENT_MAX_MINUTES = 60;

export const EMAIL_ROUTING_WORKER = 'mail-app-ingest';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const ROUTING_TIMEOUT_MS = 10_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// A skipped routing check is expected until the token and zone are configured,
// so it is said once per isolate rather than on every cron tick.
let routingSkipLogged = false;

/**
 * A numeric setting. Unset, empty, non-numeric and non-positive values fall back
 * to the default instead of disabling the check.
 *
 * @param {unknown} value
 * @param {number} fallback
 */
export function positiveSetting(value, fallback) {
  const parsed = Number(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * How long ago the owner's newest inbound message was stored. `created_at` is the
 * storage time, so a catch-all rule that stops delivering shows up here whatever
 * the senders' clocks say. An owner with no inbound mail at all counts as stale.
 *
 * @param {import('postgres').Sql} sql
 * @param {{ownerEmail: string | undefined, staleHours: number, now: Date}} options
 */
export async function checkStaleInbound(sql, { ownerEmail, staleHours, now }) {
  const [row] = await sql`
    SELECT max(m.created_at) AS newest
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE u.email = ${ownerEmail} AND m.is_sent = false
  `;
  const newest = row?.newest ? new Date(row.newest) : null;
  const newestAt = newest && Number.isFinite(newest.getTime()) ? newest : null;
  const ageHours = newestAt ? (now.getTime() - newestAt.getTime()) / HOUR_MS : null;
  return {
    stale: ageHours === null || ageHours > staleHours,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    thresholdHours: staleHours,
  };
}

/**
 * Classification rows still pending after the limit, for any message. The age
 * comes from `message_ai.created_at`, the arrival time. `updated_at` is re-stamped
 * as the recovery lease on every retry, so it cannot age a row that keeps being
 * retried without finishing.
 *
 * @param {import('postgres').Sql} sql
 * @param {{maxMinutes: number, now: Date}} options
 */
export async function checkPendingEnrichment(sql, { maxMinutes, now }) {
  const cutoff = new Date(now.getTime() - maxMinutes * MINUTE_MS).toISOString();
  const [row] = await sql`
    SELECT count(*)::int AS pending, min(ai.created_at) AS oldest
    FROM message_ai ai
    WHERE ai.status = 'pending'
      AND ai.created_at < ${cutoff}::timestamptz
  `;
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    pending: Number(row?.pending ?? 0),
    oldestAgeMinutes:
      oldest && Number.isFinite(oldest.getTime())
        ? Math.round((now.getTime() - oldest.getTime()) / MINUTE_MS)
        : null,
    thresholdMinutes: maxMinutes,
  };
}

/**
 * Whether the account-level catch-all rule still hands mail to this Worker. The
 * rule must be enabled and carry a worker action that names it. Only action types
 * come back, never their values: a forward action's value is the owner's own
 * mailbox, which must not reach Sentry.
 *
 * Throws when the API cannot be read. The caller reports that as its own failure.
 *
 * @param {{token: string, zoneId: string, fetchImpl: typeof fetch, workerName?: string}} options
 */
export async function checkEmailRoutingDrift({
  token,
  zoneId,
  fetchImpl,
  workerName = EMAIL_ROUTING_WORKER,
}) {
  const url = `${CLOUDFLARE_API}/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`;
  const rule = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    async (response) => {
      if (!response.ok)
        throw new Error(`Cloudflare email routing API responded ${response.status}`);
      const body = /** @type {any} */ (await response.json());
      return body?.result ?? null;
    },
    ROUTING_TIMEOUT_MS,
    fetchImpl,
  );
  const actions = Array.isArray(rule?.actions) ? rule.actions : [];
  const namesWorker = actions.some(
    (action) => action?.type === 'worker' && [action.value].flat().includes(workerName),
  );
  const enabled = rule?.enabled === true;
  return {
    drifted: !(enabled && namesWorker),
    enabled,
    namesWorker,
    actionTypes: [...new Set(actions.map((action) => String(action?.type ?? '')))],
  };
}

/**
 * Runs one read on a dedicated client, which is closed afterwards.
 *
 * @template T
 * @param {(url: string) => any} createSql
 * @param {string | undefined} connection
 * @param {(sql: import('postgres').Sql) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withSql(createSql, connection, run) {
  const sql = createSql(/** @type {string} */ (connection));
  try {
    return await run(sql);
  } finally {
    await endSql(sql);
  }
}

/**
 * Runs the inbound health checks and reports each failing condition to Sentry.
 * It never throws. The scheduled handler awaits it after the ingest sweeps, and a
 * failing check must neither stop those sweeps nor change the cron's outcome.
 *
 * @param {Env & {OWNER_EMAIL?: string, INBOUND_STALE_HOURS?: string, PENDING_ENRICHMENT_MAX_MINUTES?: string, EMAIL_ROUTING_ZONE_ID?: string, CLOUDFLARE_EMAIL_ROUTING_TOKEN?: string}} env
 * @param {{
 *   createSql: (url: string) => any,
 *   fetchImpl?: typeof fetch,
 *   now?: Date,
 *   report?: typeof captureInboundHealthIssue,
 *   reportFailure?: typeof captureHandledException,
 * }} deps
 */
export async function runInboundHealthChecks(env, deps) {
  const now = deps.now ?? new Date();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const report = deps.report ?? captureInboundHealthIssue;
  const reportFailure = deps.reportFailure ?? captureHandledException;
  const connection = env.HYPERDRIVE?.connectionString;
  const staleHours = positiveSetting(env.INBOUND_STALE_HOURS, DEFAULT_INBOUND_STALE_HOURS);
  const maxMinutes = positiveSetting(
    env.PENDING_ENRICHMENT_MAX_MINUTES,
    DEFAULT_PENDING_ENRICHMENT_MAX_MINUTES,
  );

  try {
    const inbound = await withSql(deps.createSql, connection, (sql) =>
      checkStaleInbound(sql, { ownerEmail: env.OWNER_EMAIL, staleHours, now }),
    );
    if (inbound.stale) {
      report('stale-inbound', 'Inbound mail has gone quiet', {
        age_hours: inbound.ageHours,
        threshold_hours: inbound.thresholdHours,
      });
    }
  } catch (err) {
    reportFailure('inbound_health', err, [connection], { check: 'stale_inbound' });
  }

  try {
    const pending = await withSql(deps.createSql, connection, (sql) =>
      checkPendingEnrichment(sql, { maxMinutes, now }),
    );
    if (pending.pending > 0) {
      report('pending-enrichment', 'Message enrichment has stayed pending', {
        pending_count: pending.pending,
        oldest_age_minutes: pending.oldestAgeMinutes,
        threshold_minutes: pending.thresholdMinutes,
      });
    }
  } catch (err) {
    reportFailure('inbound_health', err, [connection], { check: 'pending_enrichment' });
  }

  await checkRouting(env, { fetchImpl, report, reportFailure });
}

/**
 * The routing check on its own, so a failure here cannot skip the database checks
 * or throw out of the cron.
 *
 * @param {Env & {EMAIL_ROUTING_ZONE_ID?: string, CLOUDFLARE_EMAIL_ROUTING_TOKEN?: string}} env
 * @param {{fetchImpl: typeof fetch, report: typeof captureInboundHealthIssue, reportFailure: typeof captureHandledException}} deps
 */
async function checkRouting(env, { fetchImpl, report, reportFailure }) {
  const token = env.CLOUDFLARE_EMAIL_ROUTING_TOKEN;
  const zoneId = env.EMAIL_ROUTING_ZONE_ID;
  if (!token || !zoneId) {
    if (!routingSkipLogged) {
      routingSkipLogged = true;
      console.log(
        JSON.stringify({
          event: 'email_routing_check_skipped',
          reason: token ? 'zone_unset' : 'token_unset',
        }),
      );
    }
    return;
  }
  try {
    const routing = await checkEmailRoutingDrift({ token, zoneId, fetchImpl });
    if (routing.drifted) {
      report(
        'email-routing-drift',
        'Catch-all email routing no longer delivers to mail-app-ingest',
        {
          enabled: routing.enabled,
          names_worker: routing.namesWorker,
          action_types: routing.actionTypes.join(','),
        },
      );
    }
  } catch (err) {
    reportFailure('inbound_health', err, [env.HYPERDRIVE?.connectionString, token], {
      check: 'email_routing',
    });
  }
}
