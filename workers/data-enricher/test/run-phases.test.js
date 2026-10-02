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
  buildNews: vi.fn(async () => ({ sections: [{ title: 'GitHub', items: [{ url: 'u' }] }] })),
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
  storeDigest: vi.fn(async () => 'digest-1'),
  storeNews: vi.fn(async () => 'news-1'),
  fetchInterests: vi.fn(async () => []),
  fetchGithubPersonalisation: vi.fn(async () => false),
  hasNewsForUkToday: vi.fn(async () => false),
}));

import worker, { runDigestOnly, runScheduledEnrichment } from '../src/worker.js';
import { buildDigest } from '../src/digest.js';
import { buildNews } from '../src/news.js';
import {
  fetchInterests,
  hasNewsForUkToday,
  lookupUserId,
  storeDigest,
  storeNews,
} from '../src/store.js';

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
  });

  test('rebuilds inbox triage and news for ?phase=today', async () => {
    const response = await run('?phase=today');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', phase: 'today' });
    expect(storeDigest).toHaveBeenCalled();
    expect(storeNews).toHaveBeenCalled();
    expect(buildNews).toHaveBeenCalled();
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

  // Triage and news are stored after minutes of OpenAI calls; a dropped
  // socket then must not throw the whole build away.
  test('retries a store on a fresh client when the connection drops', async () => {
    vi.useFakeTimers();
    vi.mocked(storeDigest).mockRejectedValueOnce(
      Object.assign(new Error('Network connection lost.'), { code: 'CONNECTION_CLOSED' }),
    );

    const enrichment = runDigestOnly(env);
    await vi.advanceTimersByTimeAsync(1000);
    await enrichment;

    expect(storeDigest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(storeDigest).mock.calls[1][0]).not.toBe(
      vi.mocked(storeDigest).mock.calls[0][0],
    );
  });

  test('never replaces the news card with an empty round-up', async () => {
    vi.mocked(buildNews).mockResolvedValueOnce({ sections: [] });

    const response = await run('?phase=today');

    expect(response.status).toBe(200);
    expect(buildNews).toHaveBeenCalled();
    expect(storeNews).not.toHaveBeenCalled();
  });

  // The refresh button is an explicit request for a new card.
  test('rebuilds news on a manual refresh even when today is already built', async () => {
    vi.mocked(hasNewsForUkToday).mockResolvedValue(true);

    await run('?phase=today');

    expect(buildNews).toHaveBeenCalled();
    expect(storeNews).toHaveBeenCalled();
    vi.mocked(hasNewsForUkToday).mockResolvedValue(false);
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
  });

  // News sources cover the previous UK day, so an hourly rebuild only
  // re-spends OpenAI calls on the same card.
  test('builds news once per UK day', async () => {
    vi.mocked(hasNewsForUkToday).mockResolvedValueOnce(true);

    await runScheduledEnrichment(env, new Date('2026-07-06T08:00:00Z'));

    expect(hasNewsForUkToday).toHaveBeenCalledWith(expect.anything(), 'user-1');
    expect(storeDigest).toHaveBeenCalled();
    expect(buildNews).not.toHaveBeenCalled();
    expect(storeNews).not.toHaveBeenCalled();
  });

  test('does no AI work outside the saved schedule', async () => {
    await expect(runScheduledEnrichment(env, new Date('2026-07-06T07:00:00Z'))).resolves.toEqual({
      status: 'skipped',
    });
    expect(buildDigest).not.toHaveBeenCalled();
    expect(buildNews).not.toHaveBeenCalled();
  });
});

// COOKIE-WEB-1D: the news phase runs after minutes of triage OpenAI calls, by
// which time the run's own connection can have dropped.
describe('stale connections and reporting', () => {
  test('retries the news reads on a fresh client when the socket has dropped', async () => {
    vi.mocked(fetchInterests).mockRejectedValueOnce(
      Object.assign(new Error('write CONNECTION_CLOSED hyperdrive.local:5432'), {
        code: 'CONNECTION_CLOSED',
      }),
    );

    await expect(
      runScheduledEnrichment(env, new Date('2026-07-06T08:00:00Z')),
    ).resolves.toBeUndefined();

    expect(fetchInterests).toHaveBeenCalledTimes(2);
    expect(buildNews).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5-nano' }));
    expect(storeNews).toHaveBeenCalled();
  });

  test('a scheduled run with a failed phase does not rethrow the already-reported aggregate', async () => {
    vi.mocked(buildNews).mockRejectedValueOnce(new Error('news down'));

    await expect(
      worker.scheduled(
        /** @type {any} */ ({ scheduledTime: Date.parse('2026-07-06T08:00:00Z') }),
        env,
        ctx,
      ),
    ).resolves.toBeUndefined();
    expect(storeDigest).toHaveBeenCalled();
  });
});
