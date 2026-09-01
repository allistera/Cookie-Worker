import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  setTag: vi.fn(),
  withSentry: vi.fn((_options, handler) => handler),
}));
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
  buildDigest: vi.fn(),
}));
vi.mock('../src/news.js', () => ({ buildNews: vi.fn() }));
vi.mock('../src/store.js', () => ({
  lookupUserId: vi.fn(async () => 'user-1'),
  storeEmailAnalysis: vi.fn(),
  storeDigest: vi.fn(),
  storeNews: vi.fn(),
  fetchInterests: vi.fn(async () => []),
}));

/** @type {any} */
const sentry = await import('@sentry/cloudflare');
const { createSentryOptions } = await import('../src/sentry.js');
const { buildDigest } = await import('../src/digest.js');
const { lookupUserId } = await import('../src/store.js');
const worker = (await import('../src/worker.js')).default;

const CONNECTION_STRING = 'postgres://user:pass@example/db';
const TOKEN = 'test-trigger-token';
const env = /** @type {any} */ ({
  HYPERDRIVE: { connectionString: CONNECTION_STRING },
  OWNER_EMAIL: 'owner@example.com',
  OPENAI_API_KEY: 'sk-secret',
  HTTP_TRIGGER_TOKEN: TOKEN,
  SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
});
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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('Sentry configuration', () => {
  test('tags the service and keeps personal data out', () => {
    const options = createSentryOptions(env);

    expect(options).toMatchObject({
      dsn: 'https://public@example.ingest.sentry.io/1',
      enabled: true,
      environment: 'production',
      tracesSampleRate: 0,
    });
    expect(options.beforeSend?.(/** @type {any} */ ({ user: { id: 'u' } }), {})).toMatchObject({
      user: undefined,
      tags: { service: 'data-enricher' },
    });
  });
});

describe('failure reporting', () => {
  test('reports each failing phase under its own name', async () => {
    vi.mocked(buildDigest).mockRejectedValueOnce(new Error('openai exploded'));

    const response = await run('?phase=digest');

    expect(response.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0][0]).toMatchObject({ message: 'openai exploded' });
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'data-enricher', operation: 'buildDailyTriage' },
    });
  });

  test('reports a failure that happens before any phase runs', async () => {
    vi.mocked(lookupUserId).mockRejectedValueOnce(new Error(`no user in ${CONNECTION_STRING}`));

    const response = await run('?phase=digest');

    expect(response.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { operation: 'http_run' },
      extra: { phase: 'digest' },
    });
  });

  test('keeps the connection string out of Sentry and the logs', async () => {
    vi.mocked(lookupUserId).mockRejectedValueOnce(new Error(`no user in ${CONNECTION_STRING}`));

    await run();

    expect(sentry.captureException.mock.calls[0][0].message).not.toContain(CONNECTION_STRING);
    const logged = /** @type {any} */ (console.log).mock.calls
      .map((/** @type {any[]} */ call) => call[0])
      .join('\n');
    expect(logged).toContain('http_run_failed');
    expect(logged).not.toContain(CONNECTION_STRING);
  });

  test('does not report a phase failure twice through the aggregate', async () => {
    vi.mocked(buildDigest).mockRejectedValueOnce(new Error('openai exploded'));

    await run('?phase=digest');

    // runPhases rethrows an AggregateError the HTTP handler must not re-report.
    expect(sentry.captureException).toHaveBeenCalledOnce();
  });
});
