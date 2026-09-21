import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  setTag: vi.fn(),
  withSentry: vi.fn((_options, handler) => handler),
}));

/** @type {any} */
const sentry = await import('@sentry/cloudflare');
const { createSentryOptions } = await import('../src/sentry.js');
const { default: worker, FLUSH_RETRY_BASE_DELAY_MS } = await import('../src/worker.js');

const TOKEN = 'test-trigger-token';
const FLUSH_TOKEN = 'flush-secret';
const sendFetch = vi.fn();
const env = /** @type {any} */ ({
  SEND: { fetch: (/** @type {any[]} */ ...args) => sendFetch(...args) },
  COOKIE_WEB_FLUSH_TOKEN: FLUSH_TOKEN,
  HTTP_TRIGGER_TOKEN: TOKEN,
  SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
});
const ctx = /** @type {any} */ ({ waitUntil: () => undefined });

function run() {
  return worker.fetch(
    new Request('https://scheduled-send-flusher.example.workers.dev/run', {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
      tags: { service: 'scheduled-send-flusher' },
    });
  });
});

describe('failure reporting', () => {
  test('reports a failure the HTTP trigger answers with a 500', async () => {
    // A 401 is not retried, so this stays on real timers; the retry window
    // itself is covered in worker.test.js.
    sendFetch.mockResolvedValue({ ok: false, status: 401 });

    const response = await run();

    expect(response.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0][0]).toMatchObject({
      message: 'Cookie-Web flush responded 401',
    });
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'scheduled-send-flusher', operation: 'http_run' },
    });
  });

  test('keeps the flush token out of Sentry and the logs', async () => {
    sendFetch.mockImplementation(async () => {
      throw new Error(`upstream rejected Bearer ${FLUSH_TOKEN}`);
    });

    await run();

    expect(sentry.captureException.mock.calls[0][0].message).not.toContain(FLUSH_TOKEN);
    const logged = /** @type {any} */ (console.log).mock.calls
      .map((/** @type {any[]} */ call) => call[0])
      .join('\n');
    expect(logged).toContain('http_run_failed');
    expect(logged).not.toContain(FLUSH_TOKEN);
  });

  test('lets scheduled failures escape so the wrapper reports them', async () => {
    vi.useFakeTimers();
    sendFetch.mockResolvedValue({ ok: false, status: 500 });

    const scheduled = worker.scheduled(/** @type {any} */ ({}), env, ctx);
    const rejection = expect(scheduled).rejects.toThrow('Cookie-Web flush responded 500');
    await vi.advanceTimersByTimeAsync(3 * FLUSH_RETRY_BASE_DELAY_MS);

    await rejection;
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
