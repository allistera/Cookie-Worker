import { beforeEach, describe, expect, test, vi } from 'vitest';
import worker, { MAX_PARSE_BYTES, isStoreTimeout, redact, withTimeout } from '../src/index.js';
import { simpleFixture, fakeMessage } from './helpers.js';

vi.mock('postgres', () => ({
  default: vi.fn(),
}));

vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  withSentry: vi.fn((_options, handler) => handler),
}));

/** @type {any} */
const postgres = (await import('postgres')).default;
/** @type {any} */
const sentry = await import('@sentry/cloudflare');
const { createSentryOptions } = await import('../src/sentry.js');

/**
 * @param {{outcome?: 'inserted' | 'duplicate', messageUuid?: string | null}} [result]
 * @returns {any}
 */
function sqlReturning(result = { outcome: 'inserted', messageUuid: 'message-1' }) {
  /** @type {any} */
  const sql = vi.fn(async (strings) => {
    const text = strings.join('?');
    if (text.includes('SELECT') && text.includes('FROM users')) {
      return [{ user_id: 'u', is_duplicate: result.outcome === 'duplicate', thread_id: null }];
    }
    if (text.includes('INSERT INTO messages') && text.includes('RETURNING')) {
      if (result.outcome === 'duplicate') return [];
      return [{ id: result.messageUuid ?? 'message-1' }];
    }
    return [];
  });
  sql.begin = vi.fn(async (callback) => {
    await callback(sql);
    return [];
  });
  sql.end = vi.fn(async () => undefined);
  return sql;
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any}
 */
function env(overrides = {}) {
  return {
    HYPERDRIVE: { connectionString: 'postgres://user:pass@example/db' },
    FORWARD_TO: 'forward@example.com',
    OWNER_EMAIL: 'owner@example.com',
    ...overrides,
  };
}

/**
 * @returns {any}
 */
function ctx() {
  return { waitUntil: vi.fn((promise) => promise.catch?.(() => undefined)) };
}

/**
 * @returns {any}
 */
function mockedFetch() {
  return fetch;
}

/**
 * @returns {any}
 */
function mockedConsoleLog() {
  return console.log;
}

describe('email handler', () => {
  beforeEach(() => {
    postgres.mockReset();
    sentry.captureException.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/responses')) {
        return {
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              labels: [], spam_verdict: 'inbox', spam_score: 0.01,
              spam_reason: 'legitimate', priority: 'normal',
            }),
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: Array(1536).fill(0.1) }] }),
      };
    }));
  });

  test('stores and forwards exactly once', async () => {
    const sql = sqlReturning();
    postgres.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    await worker.email(message, env(), ctx());
    expect(message.forward).toHaveBeenCalledExactlyOnceWith('forward@example.com');
    expect(JSON.parse(mockedConsoleLog().mock.calls[0][0])).toMatchObject({ event: 'stored', outcome: 'inserted' });
    expect(sql.end).toHaveBeenCalled();
  });

  test('configures private Sentry error monitoring for email invocations', () => {
    const options = createSentryOptions(env({
      SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
      SENTRY_ENVIRONMENT: 'production',
    }));

    expect(options).toMatchObject({
      dsn: 'https://public@example.ingest.sentry.io/1',
      environment: 'production',
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpBodies: [],
        httpHeaders: { request: false, response: false },
        queryParams: false,
        genAI: { inputs: false, outputs: false },
        stackFrameVariables: false,
      },
      beforeSend: expect.any(Function),
    });

    const beforeSend = /** @type {NonNullable<typeof options.beforeSend>} */ (options.beforeSend);
    expect(beforeSend({
      type: undefined,
      transaction: 'Handle Email private@example.com',
      request: { data: 'email body' },
      user: { email: 'private@example.com' },
      tags: { existing: 'tag' },
    }, {})).toMatchObject({
      transaction: 'mail-app-ingest.email',
      request: undefined,
      user: undefined,
      tags: {
        existing: 'tag',
        service: 'mail-app-ingest',
        trigger: 'email',
      },
    });
  });

  test('still forwards when storage fails', async () => {
    const sql = sqlReturning();
    sql.begin = vi.fn(async () => { throw new Error('boom'); });
    postgres.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    const context = ctx();
    await worker.email(message, env(), context);
    expect(message.forward).toHaveBeenCalledOnce();
    expect(JSON.parse(mockedConsoleLog().mock.calls[0][0])).toMatchObject({ event: 'store_failed' });
    // Hard failure: no late-store waitUntil — only sql.end cleanup.
    expect(context.waitUntil).toHaveBeenCalledOnce();
    expect(sql.end).toHaveBeenCalled();
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0][0]).toMatchObject({ message: 'boom' });
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'mail-app-ingest', operation: 'store' },
      extra: { raw_size: expect.any(Number) },
    });
  });

  test('skips parse and store for oversized messages but still forwards', async () => {
    const message = fakeMessage('', { rawSize: MAX_PARSE_BYTES + 1 });
    await worker.email(message, env(), ctx());
    expect(postgres).not.toHaveBeenCalled();
    expect(message.forward).toHaveBeenCalledOnce();
    expect(JSON.parse(mockedConsoleLog().mock.calls[0][0])).toMatchObject({ event: 'store_skipped_oversize' });
  });

  test('does not log bodies or connection strings on failure', async () => {
    postgres.mockImplementation(() => { throw new Error('bad postgres://user:pass@example/db'); });
    await worker.email(fakeMessage(simpleFixture), env(), ctx());
    const logged = mockedConsoleLog().mock.calls.map((call) => call[0]).join('\n');
    expect(logged).not.toContain('simple message body');
    expect(logged).not.toContain('postgres://user:pass@example/db');
    expect(logged).toContain('database connection string is not valid');
    const captured = sentry.captureException.mock.calls[0][0];
    expect(captured.message).not.toContain('postgres://user:pass@example/db');
    expect(captured.stack).not.toContain('postgres://user:pass@example/db');
  });

  test('hands a slow store to waitUntil and forwards', async () => {
    vi.useFakeTimers();
    const slow = new Promise((resolve) => setTimeout(() => resolve([]), 6000));
    /** @type {any} */
    const sql = vi.fn(async (strings) => {
      if (strings.join('?').includes('SELECT')) return [{ user_id: 'u', is_duplicate: false, thread_id: null }];
      if (strings.join('?').includes('RETURNING')) return [{ id: 'message-1' }];
      return [];
    });
    sql.begin = vi.fn(() => slow);
    sql.end = vi.fn(async () => undefined);
    postgres.mockReturnValue(sql);
    const context = ctx();
    const run = worker.email(fakeMessage(simpleFixture), env(), context);
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(context.waitUntil).toHaveBeenCalled();
    expect(messageFromLog('store_failed')).toMatchObject({ event: 'store_failed' });
    vi.useRealTimers();
  });

  test('embeds after a late store insert when OPENAI_API_KEY is set', async () => {
    vi.useFakeTimers();
    /** @type {(value?: unknown) => void} */
    let releaseBegin = () => undefined;
    const gate = new Promise((resolve) => {
      releaseBegin = resolve;
    });
    /** @type {any} */
    const sql = vi.fn(async (strings) => {
      if (strings.join('?').includes('SELECT')) return [{ user_id: 'u', is_duplicate: false, thread_id: null }];
      if (strings.join('?').includes('RETURNING')) return [{ id: 'message-1' }];
      return [];
    });
    sql.begin = vi.fn(async (callback) => {
      await gate;
      await callback(sql);
      return [];
    });
    sql.end = vi.fn(async () => undefined);
    postgres.mockReturnValue(sql);

    /** @type {Promise<unknown>[]} */
    const pending = [];
    /** @type {any} */
    const context = {
      waitUntil: vi.fn((promise) => {
        pending.push(promise);
        return promise;
      }),
    };

    const run = worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), context);
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(messageFromLog('store_failed')).toMatchObject({ event: 'store_failed' });
    expect(mockedFetch()).not.toHaveBeenCalled();

    releaseBegin();
    await Promise.all(pending);
    expect(messageFromLog('stored_late')).toMatchObject({
      event: 'stored_late',
      outcome: 'inserted',
    });
    expect(mockedFetch()).toHaveBeenCalledTimes(2);
    expect(sql.end).toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('lets forward failures propagate for MTA retry', async () => {
    const sql = sqlReturning();
    postgres.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(new Error('forward failed'));
    await expect(worker.email(message, env(), ctx())).rejects.toThrow('forward failed');
    expect(sql.end).toHaveBeenCalled();
  });

  test('swallows permanent forward errors once the message is stored', async () => {
    postgres.mockReturnValue(sqlReturning());
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(new Error('non-authenticated emails cannot be forwarded'));
    await worker.email(message, env(), ctx());
    expect(messageFromLog('forward_failed_permanent')).toMatchObject({ event: 'forward_failed_permanent' });
  });

  test('swallows permanent forward errors for duplicates', async () => {
    postgres.mockReturnValue(sqlReturning({ outcome: 'duplicate', messageUuid: null }));
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(new Error('destination address not verified'));
    await worker.email(message, env(), ctx());
    expect(messageFromLog('forward_failed_permanent')).toMatchObject({ event: 'forward_failed_permanent' });
  });

  test('rethrows permanent forward errors when storage also failed', async () => {
    const sql = sqlReturning();
    sql.begin = vi.fn(async () => { throw new Error('boom'); });
    postgres.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(new Error('non-authenticated emails cannot be forwarded'));
    await expect(worker.email(message, env(), ctx())).rejects.toThrow('non-authenticated');
  });

  test('schedules AI enrichment only for inserted rows when OPENAI_API_KEY is set', async () => {
    const sql = sqlReturning();
    postgres.mockReturnValue(sql);
    const context = ctx();
    await worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), context);
    expect(context.waitUntil).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mockedFetch()).toHaveBeenCalledTimes(2));
  });

  test('skips AI enrichment for duplicates and missing API keys', async () => {
    postgres.mockReturnValue(sqlReturning({ outcome: 'duplicate', messageUuid: null }));
    await worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), ctx());
    expect(mockedFetch()).not.toHaveBeenCalled();

    postgres.mockReturnValue(sqlReturning());
    await worker.email(fakeMessage(simpleFixture), env(), ctx());
    expect(mockedFetch()).not.toHaveBeenCalled();
  });

  test('AI enrichment failures are swallowed inside waitUntil', async () => {
    mockedFetch().mockRejectedValueOnce(new Error('embed broke'));
    postgres.mockReturnValue(sqlReturning());
    await worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), ctx());
    await vi.waitFor(() => expect(messageFromLog('ai_enrichment_failed')).toMatchObject({
      event: 'ai_enrichment_failed',
    }));
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'mail-app-ingest', operation: 'ai_enrichment' },
    });
  });
});

describe('scheduled recovery', () => {
  beforeEach(() => {
    postgres.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  test('schedules a sweep for durable pending enrichment rows', async () => {
    const sql = sqlReturning();
    postgres.mockReturnValue(sql);
    const context = ctx();
    await worker.scheduled(/** @type {any} */ ({}), env({ OPENAI_API_KEY: 'key' }), context);
    expect(context.waitUntil).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(sql.end).toHaveBeenCalled());
    expect(sql.mock.calls.some((call) => call[0].join('?').includes('FROM message_ai'))).toBe(true);
  });
});

describe('helpers', () => {
  test('withTimeout rejects after budget', async () => {
    await expect(withTimeout(new Promise(() => undefined), 1)).rejects.toThrow('store timed out');
  });

  test('isStoreTimeout matches budget errors only', () => {
    expect(isStoreTimeout(new Error('store timed out after 5000ms'))).toBe(true);
    expect(isStoreTimeout(new Error('boom'))).toBe(false);
  });

  test('redact replaces all provided secrets', () => {
    expect(redact(new Error('a secret b key'), 'secret', 'key')).toBe('a [redacted] b [redacted]');
  });
});

/**
 * @param {string} event
 */
function messageFromLog(event) {
  const line = mockedConsoleLog().mock.calls
    .map((/** @type {unknown[]} */ call) => call[0])
    .find((entry) => typeof entry === 'string' && entry.includes(`"event":"${event}"`));
  return JSON.parse(/** @type {string} */ (line));
}
