import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The phases are stubbed at the module boundary so the routing can be asserted
// without a database or OpenAI.
vi.mock('postgres', () => ({
  default: () => {
    const sql = () => Promise.resolve([]);
    sql.end = vi.fn(async () => undefined);
    return sql;
  },
}));
vi.mock('../src/analyze.js', () => ({
  fetchImportantMessages: vi.fn(async () => []),
  analyzeEmail: vi.fn(),
}));
vi.mock('../src/digest.js', () => ({
  fetchDigestMessages: vi.fn(async () => [{ id: 'msg-1' }]),
  buildDigest: vi.fn(async () => ({
    overview: 'o',
    topics: [],
    noise: { count: 1, categories: [{ category: 'automated', count: 1 }] },
  })),
  DIGEST_KIND: 'daily_digest',
  DIGEST_PROMPT_VERSION: 'email-triage-v1',
  TRIAGE_POLICY_SOURCE: 'ericporres/email-triage-plugin',
}));
vi.mock('../src/news.js', () => ({
  buildNews: vi.fn(async () => ({ sections: [] })),
  NEWS_KIND: 'daily_news',
  NEWS_PROMPT_VERSION: 'daily-news-v1',
}));
vi.mock('../src/store.js', () => ({
  lookupUserId: vi.fn(async () => 'user-1'),
  fetchEnrichmentSettings: vi.fn(async () => ({
    model: 'gpt-5-nano',
    schedule: {
      enabled: true,
      days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      startHour: 9,
      endHour: 19,
      intervalHours: 1,
      timezone: 'Europe/London',
    },
  })),
  storeEmailAnalysis: vi.fn(async () => undefined),
  storeDigest: vi.fn(async () => 'digest-1'),
  storeNews: vi.fn(async () => 'news-1'),
  fetchInterests: vi.fn(async () => []),
  fetchGithubPersonalisation: vi.fn(async () => false),
}));

import worker, { runDigestOnly, runScheduledEnrichment } from '../src/worker.js';
import { fetchImportantMessages } from '../src/analyze.js';
import { buildDigest } from '../src/digest.js';
import { buildNews } from '../src/news.js';
import { lookupUserId, storeDigest, storeNews } from '../src/store.js';

const TOKEN = 'test-trigger-token';
const env = /** @type {any} */ ({
  HTTP_TRIGGER_TOKEN: TOKEN,
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  OWNER_EMAIL: 'owner@example.com',
  OPENAI_API_KEY: 'key',
  AI_MODEL: 'gpt-5.6-luna',
});
// The default export is Sentry-wrapped and flushes through ctx.waitUntil.
const ctx = /** @type {any} */ ({ waitUntil: () => undefined });

function run(query = '') {
  return worker.fetch(
    new Request(`https://data-enricher.example.workers.dev/run${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    env,
    ctx,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /run phase routing', () => {
  test('runs inbox triage and news generation when no phase is given', async () => {
    const response = await run();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', phase: 'all' });
    expect(fetchImportantMessages).not.toHaveBeenCalled();
    expect(storeDigest).toHaveBeenCalled();
    expect(storeNews).toHaveBeenCalled();
    expect(buildNews).toHaveBeenCalled();
    expect(buildDigest).toHaveBeenCalledWith(expect.anything(), 'key', 'gpt-5-nano');
  });

  // The refresh button must not re-analyse ten emails.
  test('runs only inbox triage for the legacy ?phase=digest name', async () => {
    const response = await run('?phase=digest');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', phase: 'digest' });
    expect(buildDigest).toHaveBeenCalled();
    expect(storeDigest).toHaveBeenCalled();
    expect(buildNews).not.toHaveBeenCalled();
    expect(fetchImportantMessages).not.toHaveBeenCalled();
  });

  test('rebuilds inbox triage and news for ?phase=today', async () => {
    const response = await run('?phase=today');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', phase: 'today' });
    expect(storeDigest).toHaveBeenCalled();
    expect(storeNews).toHaveBeenCalled();
    expect(buildNews).toHaveBeenCalled();
    expect(fetchImportantMessages).not.toHaveBeenCalled();
  });

  test('rejects an unknown phase without running anything', async () => {
    const response = await run('?phase=news');

    expect(response.status).toBe(400);
    expect(storeDigest).not.toHaveBeenCalled();
  });

  // The socket to Hyperdrive dropped under the owner lookup on the Sep 9
  // cron and failed the whole run (Sentry COOKIE-WEB-13). The reads that
  // gate a run are idempotent, so they get a fresh connection and another go.
  test('retries the gating reads on a dropped Hyperdrive connection', async () => {
    vi.useFakeTimers();
    vi.mocked(lookupUserId).mockRejectedValueOnce(
      Object.assign(new Error('write CONNECTION_CLOSED x.hyperdrive.local:5432'), {
        code: 'CONNECTION_CLOSED',
      }),
    );

    const enrichment = runDigestOnly(env);
    await vi.advanceTimersByTimeAsync(1000);
    await enrichment;

    expect(lookupUserId).toHaveBeenCalledTimes(2);
    expect(storeDigest).toHaveBeenCalled();
  });

  test('reports a generic failure when a phase throws', async () => {
    vi.mocked(buildDigest).mockRejectedValueOnce(new Error('openai exploded'));

    const response = await run('?phase=digest');

    expect(response.status).toBe(500);
    // The body must not leak the underlying error.
    await expect(response.json()).resolves.toEqual({ status: 'failed' });
  });
});

describe('scheduled enrichment', () => {
  test('runs at an enabled UK-local hour', async () => {
    await expect(
      runScheduledEnrichment(env, new Date('2026-07-06T08:00:00Z')),
    ).resolves.toBeUndefined();
    expect(storeDigest).toHaveBeenCalled();
    expect(buildNews).toHaveBeenCalled();
    expect(storeNews).toHaveBeenCalled();
    expect(fetchImportantMessages).not.toHaveBeenCalled();
  });

  test('does no AI work outside the saved schedule', async () => {
    await expect(runScheduledEnrichment(env, new Date('2026-07-06T07:00:00Z'))).resolves.toEqual({
      status: 'skipped',
    });
    expect(buildDigest).not.toHaveBeenCalled();
    expect(buildNews).not.toHaveBeenCalled();
    expect(fetchImportantMessages).not.toHaveBeenCalled();
  });
});
