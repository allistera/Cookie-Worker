import { beforeEach, describe, expect, test, vi } from 'vitest';
import worker, { MAX_PARSE_BYTES, redact, withTimeout } from '../src/index.js';
import { simpleFixture, fakeMessage } from './helpers.js';

vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(),
}));

const { neon } = await import('@neondatabase/serverless');

function sqlReturning(result = { outcome: 'inserted', messageUuid: 'message-1' }) {
  const sql = vi.fn(async (strings) => {
    if (strings.join('?').includes('SELECT')) {
      return [{ user_id: 'u', is_duplicate: result.outcome === 'duplicate', thread_id: null }];
    }
    return [];
  });
  sql.transaction = vi.fn(async () => []);
  return sql;
}

function env(overrides = {}) {
  return {
    DATABASE_URL: 'postgres://user:pass@example/db',
    FORWARD_TO: 'forward@example.com',
    OWNER_EMAIL: 'owner@example.com',
    ...overrides,
  };
}

function ctx() {
  return { waitUntil: vi.fn((promise) => promise.catch?.(() => undefined)) };
}

describe('email handler', () => {
  beforeEach(() => {
    neon.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    })));
  });

  test('stores and forwards exactly once', async () => {
    neon.mockReturnValue(sqlReturning());
    const message = fakeMessage(simpleFixture);
    await worker.email(message, env(), ctx());
    expect(message.forward).toHaveBeenCalledExactlyOnceWith('forward@example.com');
    expect(JSON.parse(console.log.mock.calls[0][0])).toMatchObject({ event: 'stored', outcome: 'inserted' });
  });

  test('still forwards when storage fails', async () => {
    const sql = sqlReturning();
    sql.transaction = vi.fn(async () => { throw new Error('boom'); });
    neon.mockReturnValue(sql);
    const message = fakeMessage(simpleFixture);
    await worker.email(message, env(), ctx());
    expect(message.forward).toHaveBeenCalledOnce();
    expect(JSON.parse(console.log.mock.calls[0][0])).toMatchObject({ event: 'store_failed' });
  });

  test('skips parse and store for oversized messages but still forwards', async () => {
    const message = fakeMessage('', { rawSize: MAX_PARSE_BYTES + 1 });
    await worker.email(message, env(), ctx());
    expect(neon).not.toHaveBeenCalled();
    expect(message.forward).toHaveBeenCalledOnce();
    expect(JSON.parse(console.log.mock.calls[0][0])).toMatchObject({ event: 'store_skipped_oversize' });
  });

  test('does not log bodies or connection strings on failure', async () => {
    neon.mockImplementation(() => { throw new Error('bad postgres://user:pass@example/db'); });
    await worker.email(fakeMessage(simpleFixture), env(), ctx());
    const logged = console.log.mock.calls.map((call) => call[0]).join('\n');
    expect(logged).not.toContain('simple message body');
    expect(logged).not.toContain('postgres://user:pass@example/db');
    expect(logged).toContain('DATABASE_URL is not a valid connection string');
  });

  test('hands a slow store to waitUntil and forwards', async () => {
    vi.useFakeTimers();
    const slow = new Promise((resolve) => setTimeout(() => resolve([]), 6000));
    const sql = vi.fn(async (strings) => {
      if (strings.join('?').includes('SELECT')) return [{ user_id: 'u', is_duplicate: false, thread_id: null }];
      return { text: strings.join('?'), values: [] };
    });
    sql.transaction = vi.fn(() => slow);
    neon.mockReturnValue(sql);
    const context = ctx();
    const run = worker.email(fakeMessage(simpleFixture), env(), context);
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(context.waitUntil).toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('lets forward failures propagate for MTA retry', async () => {
    neon.mockReturnValue(sqlReturning());
    const message = fakeMessage(simpleFixture);
    message.forward.mockRejectedValueOnce(new Error('forward failed'));
    await expect(worker.email(message, env(), ctx())).rejects.toThrow('forward failed');
  });

  test('schedules embedding only for inserted rows when OPENAI_API_KEY is set', async () => {
    neon.mockReturnValue(sqlReturning());
    const context = ctx();
    await worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), context);
    expect(context.waitUntil).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  test('skips embedding for duplicates and missing API keys', async () => {
    neon.mockReturnValue(sqlReturning({ outcome: 'duplicate', messageUuid: null }));
    await worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), ctx());
    expect(fetch).not.toHaveBeenCalled();

    neon.mockReturnValue(sqlReturning());
    await worker.email(fakeMessage(simpleFixture), env(), ctx());
    expect(fetch).not.toHaveBeenCalled();
  });

  test('embedding failures are swallowed inside waitUntil', async () => {
    fetch.mockRejectedValueOnce(new Error('embed broke'));
    neon.mockReturnValue(sqlReturning());
    await worker.email(fakeMessage(simpleFixture), env({ OPENAI_API_KEY: 'key' }), ctx());
    await Promise.resolve();
    expect(messageFromLastLog()).toMatchObject({ event: 'embed_failed' });
  });
});

describe('helpers', () => {
  test('withTimeout rejects after budget', async () => {
    await expect(withTimeout(new Promise(() => undefined), 1)).rejects.toThrow('store timed out');
  });

  test('redact replaces all provided secrets', () => {
    expect(redact(new Error('a secret b key'), 'secret', 'key')).toBe('a [redacted] b [redacted]');
  });
});

function messageFromLastLog() {
  return JSON.parse(console.log.mock.calls.at(-1)[0]);
}
