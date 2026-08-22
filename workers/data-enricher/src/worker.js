import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { timingSafeEqualStrings } from '../../../shared/auth.js';
import { connectMcp } from './mcp.js';
import { gatherTodoistTasks } from './todoist.js';
import { analyzeEmail, fetchImportantMessages } from './analyze.js';
import { buildDigest, fetchDigestMessages } from './digest.js';
import { buildNews } from './news.js';
import { captureHandledException, createSentryOptions, redact, tagTrigger } from './sentry.js';
import {
  fetchInterests,
  lookupUserId,
  storeEmailAnalysis,
  storeDigest,
  storeNews,
  storeTasks,
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

/** @param {string} content */
function fingerprint(content) {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * @param {import('postgres').Sql} sql
 * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
 * @param {string} userId
 */
async function gatherTodoist(sql, env, userId) {
  const client = await connectMcp(env.TODOIST_MCP_URL, { bearerToken: env.TODOIST_API_TOKEN });
  /** @type {import('./store.js').TaskRecord[]} */
  let tasks;
  try {
    tasks = await gatherTodoistTasks(client);
  } finally {
    await client.close();
  }
  await storeTasks(sql, userId, tasks);
  console.log(JSON.stringify({ event: 'todoist_gathered', count: tasks.length }));
}

const ANALYZE_CONCURRENCY = 3;

/**
 * @param {import('postgres').Sql} sql
 * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
 * @param {string} userId
 */
async function analyzeImportantEmails(sql, env, userId) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const messages = await fetchImportantMessages(sql, userId);
  let extracted = 0;
  // Small pool instead of a serial loop: each message is an independent
  // classify+embed pair and its own per-message store transaction, so three
  // in flight cuts the worst-case wall time (~15s per LLM call) without
  // approaching the subrequest budget.
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(ANALYZE_CONCURRENCY, messages.length) },
    async () => {
      while (nextIndex < messages.length) {
        const message = messages[nextIndex];
        nextIndex += 1;
        const analysis = await analyzeEmail(message, apiKey, env.AI_MODEL);
        const tasks = analysis.tasks.map((task) => ({
          source: /** @type {'email'} */ ('email'),
          externalId: `${message.id}:${fingerprint(task.content)}`,
          content: task.content,
          dueDate: task.due_date ?? null,
          messageId: message.id,
          raw: task,
        }));
        await storeEmailAnalysis(
          sql,
          userId,
          {
            messageId: message.id,
            summary: analysis.summary,
            model: env.AI_MODEL,
            raw: { ...analysis, prompt_version: 'email-task-analysis-v1' },
          },
          tasks,
        );
        extracted += tasks.length;
      }
    },
  );
  await Promise.all(workers);
  console.log(
    JSON.stringify({ event: 'emails_analyzed', messages: messages.length, tasks: extracted }),
  );
}

/**
 * Triage the last 24 hours of inbox mail into Reply Needed, Review, and Noise.
 * Reply Needed and Review become the AI Inbox rows; Noise is stored only as
 * category counts. Stored whole so an empty day replaces stale triage output.
 *
 * @param {import('postgres').Sql} sql
 * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
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
 * The day's personalised news for AI Today: GitHub and Product Hunt ranked
 * against the reader's stored interests, plus straight UK headlines. Stored
 * whole, so a day where every source fails replaces it with an empty set
 * rather than leaving yesterday's news looking current.
 *
 * @param {import('postgres').Sql} sql
 * @param {Env & {OPENAI_API_KEY?: string, GITHUB_API_TOKEN?: string, PRODUCT_HUNT_TOKEN?: string}} env
 * @param {string} userId
 */
async function buildDailyNews(sql, env, userId) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const interests = await fetchInterests(sql, userId);
  const news = await buildNews({
    interests,
    apiKey,
    model: env.AI_MODEL,
    // Not GITHUB_TOKEN: Actions reserves secret names with that prefix, so it
    // could never be synced as a Worker secret. Optional either way — it only
    // raises the search rate limit, and we make one request a day.
    githubToken: env.GITHUB_API_TOKEN,
    productHuntToken: env.PRODUCT_HUNT_TOKEN,
    env,
  });
  await storeNews(sql, userId, news, env.AI_MODEL);
  console.log(
    JSON.stringify({
      event: 'news_built',
      interests: interests.length,
      sections: news.sections.length,
      items: news.sections.reduce((total, section) => total + section.items.length, 0),
    }),
  );
}

/**
 * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
 * @param {Array<(sql: import('postgres').Sql, env: any, userId: string) => Promise<void>>} phases
 */
async function runPhases(env, phases) {
  const sql = createSql(env.HYPERDRIVE.connectionString);
  /** @type {Error[]} */
  const failures = [];
  try {
    const userId = await lookupUserId(sql, env.OWNER_EMAIL);
    // The phases are independent; one failing must not starve the others.
    for (const phase of phases) {
      try {
        await phase(sql, env, userId);
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
 * The nightly run: everything.
 *
 * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
 */
export async function runEnrichment(env) {
  return runPhases(env, [gatherTodoist, analyzeImportantEmails, buildDailyTriage, buildDailyNews]);
}

/**
 * Just the inbox triage. Kept separate from the full run because that one also
 * re-gathers Todoist and analyses up to ten emails one at a time — far too
 * slow and too expensive to sit behind a button.
 *
 * @param {Env & {OPENAI_API_KEY?: string}} env
 */
export async function runDigestOnly(env) {
  return runPhases(env, [buildDailyTriage]);
}

/**
 * Both of AI Today's cards, for its refresh control: inbox triage and the
 * news. A handful of model calls rather than the nightly run's dozen, so the
 * caller can await it.
 *
 * @param {Env & {OPENAI_API_KEY?: string}} env
 */
export async function runTodayRefresh(env) {
  return runPhases(env, [buildDailyTriage, buildDailyNews]);
}

const worker = {
  /**
   * @param {ScheduledController} _controller
   * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string}} env
   * @param {ExecutionContext} _ctx
   */
  async scheduled(_controller, env, _ctx) {
    tagTrigger('scheduled');
    await runEnrichment(env);
  },

  /**
   * Manual trigger: POST /run with `Authorization: Bearer <HTTP_TRIGGER_TOKEN>`.
   * `?phase=today` rebuilds both AI Today cards, which is what Cookie-Web's
   * refresh control calls; `?phase=digest` rebuilds only inbox triage (the
   * legacy phase name remains part of the deployed API); no
   * phase runs everything, as the cron does.
   *
   * @param {Request} request
   * @param {Env & {TODOIST_API_TOKEN?: string, OPENAI_API_KEY?: string, HTTP_TRIGGER_TOKEN?: string}} env
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
