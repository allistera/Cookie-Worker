import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { timingSafeEqualStrings } from '../../../shared/auth.js';
import { isEnrichmentDue } from '../../../shared/enrichmentSettings.js';
import { buildDigest, fetchDigestMessages } from './digest.js';
import { buildNews } from './news.js';
import { captureHandledException, createSentryOptions, redact, tagTrigger } from './sentry.js';
import {
  fetchEnrichmentSettings,
  fetchGithubPersonalisation,
  fetchInterests,
  lookupUserId,
  storeDigest,
  storeNews,
} from './store.js';

/** @param {string} databaseUrl */
export function createSql(databaseUrl) {
  // No ssl option: Hyperdrive terminates TLS to the origin database itself;
  // asking the driver for TLS makes every connect fail (see mail-app-ingest).
  return postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
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
  await storeDigest(sql, userId, triage, env.AI_MODEL);
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
 * @param {import('postgres').Sql} sql
 * @param {Env & {OPENAI_API_KEY?: string, GITHUB_API_TOKEN?: string, PRODUCT_HUNT_TOKEN?: string}} env
 * @param {string} userId
 */
async function buildNewsPhase(sql, env, userId) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ event: 'news_skipped', reason: 'OPENAI_API_KEY not configured' }));
    return;
  }
  const settings = await fetchEnrichmentSettings(sql, userId, env.AI_MODEL);
  const interests = (await fetchInterests(sql, userId)).filter((i) => typeof i === 'string');
  const personaliseGithub = await fetchGithubPersonalisation(sql, userId);
  const { sections } = await buildNews({
    interests,
    personaliseGithub,
    apiKey,
    model: settings.model,
    // Actions reserves GITHUB_TOKEN, so the durable Worker secret uses a name
    // that can also be configured through the deployment repository.
    githubToken: env.GITHUB_API_TOKEN,
    productHuntToken: env.PRODUCT_HUNT_TOKEN,
    env,
  });
  await storeNews(sql, userId, { sections }, settings.model);
  console.log(
    JSON.stringify({
      event: 'news_built',
      sections: sections.length,
    }),
  );
}

async function runPhases(env, phases, options = {}) {
  const sql = createSql(env.HYPERDRIVE.connectionString);
  /** @type {Error[]} */
  const failures = [];
  try {
    const userId = await lookupUserId(sql, env.OWNER_EMAIL);
    const settings = await fetchEnrichmentSettings(sql, userId, env.AI_MODEL);
    if (options.scheduledAt && !isEnrichmentDue(settings, options.scheduledAt)) {
      console.log(JSON.stringify({ event: 'scheduled_run_skipped' }));
      return { status: 'skipped' };
    }
    const runtimeEnv = { ...env, AI_MODEL: settings.model };
    // The phases are independent; one failing must not starve the others.
    for (const phase of phases) {
      try {
        await phase(sql, runtimeEnv, userId);
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
    tagTrigger('scheduled');
    await runScheduledEnrichment(env, new Date(controller.scheduledTime));
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
