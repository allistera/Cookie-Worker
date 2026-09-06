import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import worker, {
  MAX_PARSE_BYTES,
  isStoreTimeout,
  isTransientDbError,
  recoverPendingEnrichment,
  redact,
  withTimeout,
} from '../src/worker.js';
import { simpleFixture, fakeMessage } from './helpers.js';

vi.mock('postgres', () => ({
  default: vi.fn(),
}));

// Search indexing is stubbed so its call can be asserted directly: the point
// of these tests is which paths reach it, not what it sends to Meilisearch
// (shared/meiliSync.test.js covers that).
const { syncMessageToMeili, syncMessagesToMeili } = vi.hoisted(() => ({
  syncMessageToMeili: vi.fn().mockResolvedValue(undefined),
  syncMessagesToMeili: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../shared/meiliSync.js', () => ({ syncMessageToMeili, syncMessagesToMeili }));

vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  withSentry: vi.fn((_options, handler) => handler),
}));

/** @type {any} */
const postgres = (await import('postgres')).default;
/** @type {any} */
const sentry = await import('@sentry/cloudflare');
const { createSentryOptions } = await import('../src/sentry.js');

afterEach(() => {
  vi.useRealTimers();
});

/**
 * @param {{outcome?: 'inserted' | 'duplicate', messageUuid?: string | null, quotaAllowed?: boolean}} [result]
 * @returns {any}
 */
function sqlReturning(result = { outcome: 'inserted', messageUuid: 'message-1' }) {
  /** @type {any} */
  const sql = vi.fn(async (strings) => {
    const text = strings.join('?');
    if (text.includes('LEFT JOIN message_ai')) return [{ status: 'pending', user_id: 'u' }];
    if (text.includes('INSERT INTO api_rate_limits'))
      return [{ allowed: result.quotaAllowed !== false }];
    if (text.includes('SELECT') && text.includes('FROM users')) {
      return [{ user_id: 'u', is_duplicate: result.outcome === 'duplicate', thread_id: null }];
    }
    if (text.includes('AS is_duplicate') && text.includes('AS thread_id')) {
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
  // Mirrors postgres.js's sql.json: marks a value to be sent as a real jsonb
  // parameter instead of pre-stringifying it into a jsonb string scalar.
  sql.json = (value) => ({ __pgJson: value });
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            labels: [],
            spam_verdict: 'inbox',
            spam_score: 0.01,
            spam_reason: 'legitimate',
            priority: 'normal',
          }),
        }),
      })),
    );
  });

  test('stores and forwards exactly once', async () => {
    const sql = sqlReturning();
    postgres.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    await worker.email(message, env(), ctx());
    expect(message.forward).toHaveBeenCalledExactlyOnceWith('forward@example.com');
    expect(JSON.parse(mockedConsoleLog().mock.calls[0][0])).toMatchObject({
      event: 'stored',
      outcome: 'inserted',
    });
    expect(sql.end).toHaveBeenCalled();
  });

  test('stores and forwards mail when the AI budget is exhausted', async () => {
    const sql = sqlReturning({ quotaAllowed: false });
    postgres.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    const pending = [];
    await worker.email(
      message,
      env({ OPENAI_API_KEY: 'key' }),
      /** @type {any} */ ({ waitUntil: (promise) => pending.push(promise) }),
    );
    await Promise.all(pending);
    expect(message.forward).toHaveBeenCalledExactlyOnceWith('forward@example.com');
    expect(message.setReject).not.toHaveBeenCalled();
    expect(mockedFetch()).not.toHaveBeenCalled();
    expect(messageFromLog('stored')).toMatchObject({ outcome: 'inserted' });
  });

  test('saves a priority reply after classification while only forwarding the original email', async () => {
    const sql = sqlReturning();
    const original = sql.getMockImplementation();
    const savedDrafts = [];
    sql.mockImplementation(async (strings, ...values) => {
      const text = strings.join('?');
      if (
        text.includes('RETURNING m.id') ||
        text.includes('SELECT m.id, m.user_id, m.from_address')
      )
        return [
          {
            id: 'message-1',
            user_id: 'u',
            from_address: 'alice@example.com',
            subject: 'Hello there',
            body_text: 'Can you review the plan?',
            reply_draft_attempts: 1,
          },
        ];
      if (text.includes('INSERT INTO drafts')) {
        savedDrafts.push(values);
        return [{ id: 'draft-1' }];
      }
      return original(strings, ...values);
    });
    sql.begin = async (callback) => callback(sql);
    postgres.mockReturnValue(sql);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        return Response.json({
          output_text: JSON.stringify(
            body.text.format.name === 'priority_reply'
              ? { text: 'Thanks for the plan. Which section needs attention first?' }
              : {
                  labels: [],
                  rules: [],
                  spam_verdict: 'inbox',
                  spam_score: 0,
                  spam_reason: 'legitimate',
                  priority: 'high',
                },
          ),
        });
      }),
    );
    const pending = [];
    const message = fakeMessage(simpleFixture);
    await worker.email(
      message,
      env({ OPENAI_API_KEY: 'key' }),
      /** @type {any} */ ({
        waitUntil: (promise) => pending.push(promise),
      }),
    );
    await Promise.all(pending);
    expect(savedDrafts).toHaveLength(1);
    expect(savedDrafts[0]).toContain('Thanks for the plan. Which section needs attention first?');
    expect(savedDrafts[0]).toContain('alice@example.com');
    expect(message.forward).toHaveBeenCalledExactlyOnceWith('forward@example.com');
    expect(
      mockedFetch().mock.calls.every(([url]) => url === 'https://api.openai.com/v1/responses'),
    ).toBe(true);
  });

  test('configures private Sentry error monitoring for email invocations', () => {
    const options = createSentryOptions(
      env({
        SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
        SENTRY_ENVIRONMENT: 'production',
      }),
    );

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
    expect(
      beforeSend(
        {
          type: undefined,
          transaction: 'Handle Email private@example.com',
          request: { data: 'email body' },
          user: { email: 'private@example.com' },
          tags: { existing: 'tag' },
        },
        {},
      ),
    ).toMatchObject({
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

  test('drops unhandled transient forward errors so MTA retries are not Sentry noise', () => {
    const options = createSentryOptions(
      env({ SENTRY_DSN: 'https://public@example.ingest.sentry.io/1' }),
    );
    const beforeSend = /** @type {NonNullable<typeof options.beforeSend>} */ (options.beforeSend);
    const transientMessage =
      'could not send email: Temporary Unknown error: transient error (421): 4.7.28 Gmail has detected an unusual rate of unsolicited mail';

    // The intentional rethrow for MTA retry must not report as a crash.
    expect(
      beforeSend(
        /** @type {any} */ ({
          exception: {
            values: [
              {
                type: 'Error',
                value: transientMessage,
                mechanism: { type: 'auto.faas.cloudflare.email', handled: false },
              },
            ],
          },
        }),
        {},
      ),
    ).toBeNull();

    // Explicitly captured (handled) events keep flowing even with the same text.
    expect(
      beforeSend(
        /** @type {any} */ ({
          exception: {
            values: [
              {
                type: 'Error',
                value: transientMessage,
                mechanism: { type: 'generic', handled: true },
              },
            ],
          },
        }),
        {},
      ),
    ).not.toBeNull();

    // Permanent SMTP failures and unknown crashes still report.
    expect(
      beforeSend(
        /** @type {any} */ ({
          exception: {
            values: [
              {
                type: 'Error',
                value: 'could not send email: Unknown error: permanent error (550): rejected',
                mechanism: { type: 'auto.faas.cloudflare.email', handled: false },
              },
            ],
          },
        }),
        {},
      ),
    ).not.toBeNull();
    expect(
      beforeSend(
        /** @type {any} */ ({
          exception: {
            values: [
              { type: 'TypeError', value: 'x is not a function', mechanism: { handled: false } },
            ],
          },
        }),
        {},
      ),
    ).not.toBeNull();
  });

  test('does not forward when storage fails so the MTA retries', async () => {
    const sql = sqlReturning();
    sql.begin = vi.fn(async () => {
      throw new Error('boom');
    });
    postgres.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    const context = ctx();
    await expect(worker.email(message, env(), context)).rejects.toThrow('boom');
    expect(message.forward).not.toHaveBeenCalled();
    expect(JSON.parse(mockedConsoleLog().mock.calls[0][0])).toMatchObject({
      event: 'store_failed',
    });
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
    expect(JSON.parse(mockedConsoleLog().mock.calls[0][0])).toMatchObject({
      event: 'store_skipped_oversize',
    });
  });

  test('does not log bodies or connection strings on failure', async () => {
    postgres.mockImplementation(() => {
      throw new Error('bad postgres://user:pass@example/db');
    });
    await expect(worker.email(fakeMessage(simpleFixture), env(), ctx())).rejects.toThrow();
    const logged = mockedConsoleLog()
      .mock.calls.map((call) => call[0])
      .join('\n');
    expect(logged).not.toContain('simple message body');
    expect(logged).not.toContain('postgres://user:pass@example/db');
    expect(logged).toContain('database connection string is not valid');
    const captured = sentry.captureException.mock.calls[0][0];
    expect(captured.message).not.toContain('postgres://user:pass@example/db');
    expect(captured.stack).not.toContain('postgres://user:pass@example/db');
  });

  test('hands a slow store to waitUntil and rethrows so the MTA retries', async () => {
    vi.useFakeTimers();
    const slow = new Promise((resolve) => setTimeout(() => resolve([]), 6000));
    /** @type {any} */
    const sql = vi.fn(async (strings) => {
      if (strings.join('?').includes('INSERT INTO api_rate_limits')) return [{ allowed: true }];
      if (strings.join('?').includes('SELECT'))
        return [{ user_id: 'u', is_duplicate: false, thread_id: null }];
      if (strings.join('?').includes('RETURNING')) return [{ id: 'message-1' }];
      return [];
    });
    sql.begin = vi.fn(() => slow);
    sql.end = vi.fn(async () => undefined);
    postgres.mockReturnValue(sql);
    const context = ctx();
    const message = fakeMessage(simpleFixture);
    const run = worker.email(message, env(), context);
    const settled = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await settled;
    expect(message.forward).not.toHaveBeenCalled();
    expect(context.waitUntil).toHaveBeenCalled();
    expect(messageFromLog('store_failed')).toMatchObject({ event: 'store_failed' });
    vi.useRealTimers();
  });

  test('runs AI enrichment after a late store insert when OPENAI_API_KEY is set', async () => {
    vi.useFakeTimers();
    /** @type {(value?: unknown) => void} */
    let releaseBegin = () => undefined;
    const gate = new Promise((resolve) => {
      releaseBegin = resolve;
    });
    /** @type {any} */
    const sql = vi.fn(async (strings) => {
      if (strings.join('?').includes('INSERT INTO api_rate_limits')) return [{ allowed: true }];
      if (strings.join('?').includes('SELECT'))
        return [{ user_id: 'u', is_duplicate: false, thread_id: null }];
      if (strings.join('?').includes('RETURNING')) return [{ id: 'message-1' }];
      return [];
    });
    sql.begin = vi.fn(async (callback) => {
      await gate;
      await callback(sql);
      return [];
    });
    sql.end = vi.fn(async () => undefined);
    sql.json = (value) => ({ __pgJson: value });
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
    const settled = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await settled;
    expect(messageFromLog('store_failed')).toMatchObject({ event: 'store_failed' });
    expect(mockedFetch()).not.toHaveBeenCalled();

    releaseBegin();
    await Promise.all(pending);
    expect(messageFromLog('stored_late')).toMatchObject({
      event: 'stored_late',
      outcome: 'inserted',
    });
    expect(mockedFetch()).toHaveBeenCalledTimes(1);
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

  test('logs transient forward failures before rethrowing for MTA retry', async () => {
    postgres.mockReturnValue(sqlReturning());
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(
      new Error(
        'could not send email: Temporary Unknown error: transient error (421): 4.7.28 Gmail has detected an unusual rate of unsolicited mail',
      ),
    );
    await expect(worker.email(message, env(), ctx())).rejects.toThrow('transient error (421)');
    expect(messageFromLog('forward_failed_transient')).toMatchObject({
      event: 'forward_failed_transient',
      message_id: expect.any(String),
    });
  });

  test('swallows permanent forward errors once the message is stored', async () => {
    postgres.mockReturnValue(sqlReturning());
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(
      new Error('non-authenticated emails cannot be forwarded'),
    );
    await worker.email(message, env(), ctx());
    expect(messageFromLog('forward_failed_permanent')).toMatchObject({
      event: 'forward_failed_permanent',
    });
  });

  test('swallows permanent forward errors for duplicates', async () => {
    postgres.mockReturnValue(sqlReturning({ outcome: 'duplicate', messageUuid: null }));
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(new Error('destination address not verified'));
    await worker.email(message, env(), ctx());
    expect(messageFromLog('forward_failed_permanent')).toMatchObject({
      event: 'forward_failed_permanent',
    });
  });

  test('rethrows permanent forward errors when storage also failed', async () => {
    const sql = sqlReturning();
    sql.begin = vi.fn(async () => {
      throw new Error('boom');
    });
    postgres.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(
      new Error('non-authenticated emails cannot be forwarded'),
    );
    await expect(worker.email(message, env(), ctx())).rejects.toThrow('boom');
    expect(message.forward).not.toHaveBeenCalled();
  });

  test('schedules AI enrichment only for inserted rows when OPENAI_API_KEY is set', async () => {
    const sql = sqlReturning();
    postgres.mockReturnValue(sql);
    const context = ctx();
    await worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), context);
    expect(context.waitUntil).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mockedFetch()).toHaveBeenCalledTimes(1));
  });

  // Indexing used to sit behind `env.OPENAI_API_KEY` alongside classification.
  // A rotated or missing key then stopped new mail being searchable at all,
  // which was survivable when Meilisearch was one leg of three and is not now.
  test('indexes an inserted message even without OPENAI_API_KEY', async () => {
    syncMessageToMeili.mockClear();
    postgres.mockReturnValue(sqlReturning());

    await worker.email(fakeMessage(simpleFixture), env(), ctx());

    await vi.waitFor(() => expect(syncMessageToMeili).toHaveBeenCalledOnce());
    expect(typeof syncMessageToMeili.mock.calls[0][2]).toBe('string');
    // ...and still runs no classification, which genuinely does need the key.
    expect(mockedFetch()).not.toHaveBeenCalled();
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
    mockedFetch().mockRejectedValueOnce(new Error('classification broke'));
    postgres.mockReturnValue(sqlReturning());
    await worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), ctx());
    await vi.waitFor(() =>
      expect(messageFromLog('ai_enrichment_failed')).toMatchObject({
        event: 'ai_enrichment_failed',
      }),
    );
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
    // Recovery of classification and reply drafts, search drift, and spam
    // retention run independently, so one failure cannot stop another.
    expect(context.waitUntil).toHaveBeenCalledTimes(4);
    await vi.waitFor(() => expect(sql.end).toHaveBeenCalled());
    const recoveryQuery = sql.mock.calls
      .map((call) => call[0].join('?'))
      .find((query) => query.includes('FROM message_ai'));
    expect(recoveryQuery).toContain("ai.status IN ('pending', 'failed')");
    expect(recoveryQuery).not.toContain('embedding');
  });

  test('retries a transient connection failure with a fresh client', async () => {
    vi.useFakeTimers();
    const firstSql = sqlReturning();
    firstSql.begin = vi.fn(async () => {
      throw Object.assign(new Error('Failed to connect to database: timeout'), {
        code: 'CONNECT_TIMEOUT',
      });
    });
    const secondSql = sqlReturning();
    postgres.mockReturnValueOnce(firstSql).mockReturnValueOnce(secondSql);

    const recovery = recoverPendingEnrichment(env({ OPENAI_API_KEY: 'key' }));
    await vi.advanceTimersByTimeAsync(1000);
    await recovery;

    expect(postgres).toHaveBeenCalledTimes(2);
    expect(firstSql.end).toHaveBeenCalledOnce();
    expect(secondSql.end).toHaveBeenCalledOnce();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  test('captures a persistent recovery connection failure once', async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error('Failed to connect to database'), {
      code: '08006',
    });
    const clients = [sqlReturning(), sqlReturning(), sqlReturning()];
    for (const sql of clients) {
      sql.begin = vi.fn(async () => {
        throw error;
      });
    }
    postgres
      .mockReturnValueOnce(clients[0])
      .mockReturnValueOnce(clients[1])
      .mockReturnValueOnce(clients[2]);

    const recovery = recoverPendingEnrichment(env({ OPENAI_API_KEY: 'key' }));
    await vi.advanceTimersByTimeAsync(3000);
    await recovery;

    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'mail-app-ingest', operation: 'ai_recovery' },
    });
    expect(clients.every((sql) => sql.end.mock.calls.length === 1)).toBe(true);
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

  test('isTransientDbError matches connection failures only', () => {
    expect(isTransientDbError(Object.assign(new Error('database down'), { code: '08001' }))).toBe(
      true,
    );
    expect(isTransientDbError(new Error('write timed out'))).toBe(true);
    expect(isTransientDbError(new Error('Network connection lost.'))).toBe(true);
    expect(isTransientDbError(new Error('syntax error'))).toBe(false);
  });

  test('isTransientForwardError matches SMTP 4xx forward errors only', async () => {
    const { isTransientForwardError } = await import('../src/sentry.js');
    expect(
      isTransientForwardError(
        new Error(
          'could not send email: Temporary Unknown error: transient error (421): 4.7.28 Gmail has detected an unusual rate of unsolicited mail',
        ),
      ),
    ).toBe(true);
    expect(
      isTransientForwardError(
        new Error('could not send email: Unknown error: transient error (451): try again later'),
      ),
    ).toBe(true);
    expect(
      isTransientForwardError(
        new Error('could not send email: Unknown error: permanent error (550): rejected'),
      ),
    ).toBe(false);
    expect(isTransientForwardError(new Error('transient error (421)'))).toBe(false);
    expect(isTransientForwardError(new Error('boom'))).toBe(false);
    expect(isTransientForwardError('not an error')).toBe(false);
  });

  test('redact replaces all provided secrets', () => {
    expect(redact(new Error('a secret b key'), 'secret', 'key')).toBe('a [redacted] b [redacted]');
  });
});

/**
 * @param {string} event
 */
function messageFromLog(event) {
  const line = mockedConsoleLog()
    .mock.calls.map((/** @type {unknown[]} */ call) => call[0])
    .find((entry) => typeof entry === 'string' && entry.includes(`"event":"${event}"`));
  return JSON.parse(/** @type {string} */ (line));
}
