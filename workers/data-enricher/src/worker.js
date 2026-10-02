import * as Sentry from '@sentry/cloudflare';
import { timingSafeEqualStrings } from '../../../shared/auth.js';
import { createSql, endSql } from '../../../shared/db.js';
import { isEnrichmentDue } from '../../../shared/enrichmentSettings.js';
import { retryWithBackoff } from '../../../shared/retry.js';
import { isTransientDbError, retryWithFreshClient } from '../../../shared/transient-db.js';
import { buildDigest, fetchDigestMessages } from './digest.js';
import { buildNews } from './news.js';
import { captureHandledException, createSentryOptions, redact, tagTrigger } from './sentry.js';
import {
  fetchEnrichmentSettings,
  fetchGithubPersonalisation,
  fetchInterests,
  hasNewsForUkToday,
  lookupUserId,
  storeDigest,
  storeNews,
} from './store.js';

import { configureOpenAi } from '../../../shared/openai.js';

/**
 * Runs idempotent database work on a fresh client, with another go on a new
 * one if the socket drops. Anything after the first phase follows minutes of
 * OpenAI calls, long enough for the run's own connection to have gone stale
 * (Sentry COOKIE-WEB-1D). Stores replace the previous row inside one
 * transaction and reads have no side effects, so a retry cannot duplicate
 * anything.
 *
 * @template T
 * @param {{HYPERDRIVE: {connectionString: string}}} env
 * @param {(sql: import('postgres').Sql) => Promise<T>} work
 * @returns {Promise<T>}
 */
function withFreshClient(env, work) {
  return retryWithFreshClient(() => createSql(env.HYPERDRIVE.connectionString), work);
}

/**
 * Triage the last 24 hours of inbox mail into Reply Needed, Review, and Noise.
 * Reply Needed and Review become the AI Inbox rows; Noise is stored only as
 * category counts. Stored whole so an empty day replaces stale triage output.
 *
 * @param {import('postgres').Sql} sql
 * @param {Env & {OPENAI_API_KEY?: string}} env
 * @param {string} userId
 */
async function buildDailyTriage(sql, env, userId) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const messages = await fetchDigestMessages(sql, userId);
  const triage = messages.length
    ? await buildDigest(messages, apiKey, env.AI_MODEL)
    : { overview: '', topics: [], noise: { count: 0, categories: [] } };
  await withFreshClient(env, (fresh) =>
    storeDigest(
      fresh,
      userId,
      triage,
      env.AI_MODEL,
      messages.map((message) => message.id),
    ),
  );
  console.log(
    JSON.stringify({
      event: 'triage_built',
      messages: messages.length,
      visible: triage.topics.reduce((total, topic) => total + topic.items.length, 0),
      noise: triage.noise.count,
    }),
  );
}

/**
 * Generates and stores the daily news round-up (GitHub repos, Product Hunt,
 * UK headlines). Uses the GitHub token when available to avoid rate limits.
 *
 * Scheduled runs build it once per UK day; a manual refresh always rebuilds.
 * An empty round-up is never stored, so a bad hour keeps the previous card.
 *
 * @param {import('postgres').Sql} _sql the run's client, unused: by now it may be stale
 * @param {Env & {OPENAI_API_KEY?: string, GITHUB_API_TOKEN?: string, PRODUCT_HUNT_TOKEN?: string}} env
 * @param {string} userId
 * @param {RunOptions} [options]
 */
async function buildNewsPhase(_sql, env, userId, options = {}) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ event: 'news_skipped', reason: 'OPENAI_API_KEY not configured' }));
    return;
  }
  // runPhases already resolved the model from the user's settings into
  // env.AI_MODEL, so only the news-specific reads remain.
  const inputs = await withFreshClient(env, async (fresh) => {
    if (options.scheduledAt && (await hasNewsForUkToday(fresh, userId))) return null;
    const interests = (await fetchInterests(fresh, userId)).filter((i) => typeof i === 'string');
    const personaliseGithub = await fetchGithubPersonalisation(fresh, userId);
    return { interests, personaliseGithub };
  });
  if (!inputs) {
    console.log(JSON.stringify({ event: 'news_skipped', reason: 'already built today' }));
    return;
  }
  const { interests, personaliseGithub } = inputs;
  const { sections } = await buildNews({
    interests,
    personaliseGithub,
    apiKey,
    model: env.AI_MODEL,
    // Actions reserves GITHUB_TOKEN, so the durable Worker secret uses a name
    // that can also be configured through the deployment repository.
    githubToken: env.GITHUB_API_TOKEN,
    productHuntToken: env.PRODUCT_HUNT_TOKEN,
    env,
  });
  if (sections.length === 0) {
    console.log(JSON.stringify({ event: 'news_skipped', reason: 'no sections' }));
    return;
  }
  await withFreshClient(env, (fresh) => storeNews(fresh, userId, { sections }, env.AI_MODEL));
  console.log(
    JSON.stringify({
      event: 'news_built',
      sections: sections.length,
    }),
  );
}

/** @typedef {{scheduledAt?: Date}} RunOptions */

/**
 * @param {Env} env
 * @param {Array<(sql: import('postgres').Sql, env: any, userId: string, options: RunOptions) => Promise<void>>} phases
 * @param {RunOptions} [options]
 */
async function runPhases(env, phases, options = {}) {
  let sql = createSql(env.HYPERDRIVE.connectionString);
  /** @type {Error[]} */
  const failures = [];
  try {
    // The socket to Hyperdrive drops now and then (Sentry COOKIE-WEB-13). The
    // two reads that gate a run are idempotent, so they get a fresh client
    // and another go rather than failing the whole hour.
    const { userId, settings } = await retryWithBackoff(
      async (attempt) => {
        if (attempt > 1) {
          await endSql(sql);
          sql = createSql(env.HYPERDRIVE.connectionString);
        }
        const userId = await lookupUserId(sql, env.OWNER_EMAIL);
        const settings = await fetchEnrichmentSettings(sql, userId, env.AI_MODEL);
        return { userId, settings };
      },
      { attempts: 3, isRetryable: isTransientDbError },
    );
    if (options.scheduledAt && !isEnrichmentDue(settings, options.scheduledAt)) {
      console.log(JSON.stringify({ event: 'scheduled_run_skipped' }));
      return { status: 'skipped' };
    }
    const runtimeEnv = { ...env, AI_MODEL: settings.model };
    // The phases are independent; one failing must not starve the others.
    for (const phase of phases) {
      try {
        await phase(sql, runtimeEnv, userId, options);
      } catch (error) {
        failures.push(/** @type {Error} */ (error));
        console.log(
          JSON.stringify({ event: 'phase_failed', phase: phase.name, error: redact(error, env) }),
        );
        // Reported per phase rather than only through the AggregateError
        // below: one failing phase is the actionable signal, and the manual
        // HTTP trigger swallows the aggregate to keep its response generic.
        captureHandledException(phase.name, error, env);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'data-enricher run had failures');
  }
}

/**
 * All entry points run inbox triage and news generation.
 *
 * @param {Env & {OPENAI_API_KEY?: string}} env
 */
export async function runEnrichment(env) {
  return runPhases(env, [buildDailyTriage, buildNewsPhase]);
}

/** @param {Env & {OPENAI_API_KEY?: string}} env @param {Date} scheduledAt */
export async function runScheduledEnrichment(env, scheduledAt) {
  return runPhases(env, [buildDailyTriage, buildNewsPhase], {
    scheduledAt,
  });
}

/**
 * Legacy digest entry point; retained for deployed callers.
 *
 * @param {Env & {OPENAI_API_KEY?: string}} env
 */
export async function runDigestOnly(env) {
  return runPhases(env, [buildDailyTriage]);
}

/**
 * AI Today refresh rebuilds both cards shown on the page.
 *
 * @param {Env & {OPENAI_API_KEY?: string}} env
 */
export async function runTodayRefresh(env) {
  return runPhases(env, [buildDailyTriage, buildNewsPhase]);
}

const worker = {
  /**
   * @param {ScheduledController} controller
   * @param {Env & {OPENAI_API_KEY?: string}} env
   * @param {ExecutionContext} _ctx
   */
  async scheduled(controller, env, _ctx) {
    configureOpenAi(env);
    tagTrigger('scheduled');
    try {
      await runScheduledEnrichment(env, new Date(controller.scheduledTime));
    } catch (error) {
      // runPhases already captured every failure inside an AggregateError;
      // rethrowing it made withSentry report the same failure a second time
      // (COOKIE-WEB-1D had two events per run). Anything else failed before
      // the phases ran, so let it propagate to withSentry.
      if (!(error instanceof AggregateError)) throw error;
      console.log(JSON.stringify({ event: 'scheduled_run_failed', failures: error.errors.length }));
    }
  },

  /**
   * Manual trigger: POST /run with `Authorization: Bearer <HTTP_TRIGGER_TOKEN>`.
   * When no phase is specified, all phases run (inbox triage + news generation).
   * The today/digest aliases and response phase names remain compatible with
   * deployed callers.
   *
   * @param {Request} request
   * @param {Env & {OPENAI_API_KEY?: string, HTTP_TRIGGER_TOKEN?: string}} env
   * @param {ExecutionContext} _ctx
   */
  async fetch(request, env, _ctx) {
    configureOpenAi(env);
    tagTrigger('http');
    const url = new URL(request.url);
    if (url.pathname !== '/run') {
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    // An unset token keeps the endpoint closed rather than open.
    if (
      !env.HTTP_TRIGGER_TOKEN ||
      !(await timingSafeEqualStrings(
        request.headers.get('Authorization'),
        `Bearer ${env.HTTP_TRIGGER_TOKEN}`,
      ))
    ) {
      return new Response('Unauthorized', { status: 401 });
    }
    const phase = url.searchParams.get('phase');
    const runners = { digest: runDigestOnly, today: runTodayRefresh };
    if (phase !== null && !Object.hasOwn(runners, phase)) {
      return Response.json({ status: 'failed', error: 'unknown phase' }, { status: 400 });
    }
    try {
      await (phase === null ? runEnrichment(env) : runners[phase](env));
      return Response.json({ status: 'ok', phase: phase ?? 'all' });
    } catch (error) {
      // Body stays generic: nested errors may carry connection details.
      console.log(
        JSON.stringify({
          event: 'http_run_failed',
          phase: phase ?? 'all',
          error: redact(error, env),
        }),
      );
      // An AggregateError means every failure inside it was already captured
      // by runPhases; anything else (user lookup, the database client) failed
      // before the phases ran and would otherwise be reported nowhere.
      if (!(error instanceof AggregateError)) {
        captureHandledException('http_run', error, env, { phase: phase ?? 'all' });
      }
      return Response.json({ status: 'failed' }, { status: 500 });
    }
  },
};

export default Sentry.withSentry(createSentryOptions, worker);
