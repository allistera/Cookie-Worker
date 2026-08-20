import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  setTag: vi.fn(),
}));

/** @type {any} */
const sentry = await import('@sentry/cloudflare');
const { captureHandledException, createSentryOptions, redact, tagTrigger } =
  await import('./sentry.js');

const DSN = 'https://public@example.ingest.sentry.io/1';

/**
 * @param {Partial<import('@sentry/core').ErrorEvent>} [event]
 * @returns {any}
 */
function errorEvent(event = {}) {
  return { type: undefined, ...event };
}

beforeEach(() => {
  sentry.captureException.mockReset();
  sentry.setTag.mockReset();
});

describe('createSentryOptions', () => {
  test('stays disabled until a DSN is configured', () => {
    expect(createSentryOptions({ service: 'a-worker', env: {} })).toMatchObject({
      dsn: undefined,
      enabled: false,
      environment: 'production',
    });
    expect(
      createSentryOptions({
        service: 'a-worker',
        env: { SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: 'staging' },
      }),
    ).toMatchObject({ dsn: DSN, enabled: true, environment: 'staging' });
  });

  test('opts out of every category of personal data', () => {
    expect(createSentryOptions({ service: 'a-worker', env: { SENTRY_DSN: DSN } })).toMatchObject({
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        queryParams: false,
        genAI: { inputs: false, outputs: false },
        stackFrameVariables: false,
      },
    });
  });

  test('strips request, user, and breadcrumbs and tags the service', () => {
    const { beforeSend } = createSentryOptions({ service: 'a-worker', env: { SENTRY_DSN: DSN } });

    expect(
      beforeSend?.(
        errorEvent({
          transaction: 'POST /run',
          request: { data: 'body' },
          user: { email: 'private@example.com' },
          breadcrumbs: [{ message: 'a query' }],
          tags: { existing: 'tag' },
        }),
        {},
      ),
    ).toMatchObject({
      // Multi-trigger Workers keep Sentry's own transaction name.
      transaction: 'POST /run',
      request: undefined,
      user: undefined,
      breadcrumbs: undefined,
      tags: { existing: 'tag', service: 'a-worker' },
    });
  });

  test('renames the transaction for a single-trigger Worker', () => {
    const { beforeSend } = createSentryOptions({
      service: 'a-worker',
      env: { SENTRY_DSN: DSN },
      trigger: 'email',
    });

    expect(
      beforeSend?.(errorEvent({ transaction: 'Handle Email private@example.com' }), {}),
    ).toMatchObject({
      transaction: 'a-worker.email',
      tags: { service: 'a-worker', trigger: 'email' },
    });
  });

  test('lets a Worker drop its own expected events', () => {
    const { beforeSend } = createSentryOptions({
      service: 'a-worker',
      env: { SENTRY_DSN: DSN },
      beforeSend: (event) => (event.transaction === 'expected' ? null : event),
    });

    expect(beforeSend?.(errorEvent({ transaction: 'expected' }), {})).toBeNull();
    expect(beforeSend?.(errorEvent({ transaction: 'unexpected' }), {})).not.toBeNull();
  });
});

describe('captureHandledException', () => {
  test('tags the service and operation', () => {
    captureHandledException('a-worker', 'flush', new Error('boom'), [], { attempt: 2 });

    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0][0]).toMatchObject({ message: 'boom' });
    expect(sentry.captureException.mock.calls[0][1]).toEqual({
      tags: { service: 'a-worker', operation: 'flush' },
      extra: { attempt: 2 },
    });
  });

  test('removes secrets from the message and the stack, keeping the error name', () => {
    const error = new TypeError('connect postgres://user:pass@example/db failed');
    error.stack = 'TypeError: connect postgres://user:pass@example/db failed\n  at connect';

    captureHandledException('a-worker', 'store', error, ['postgres://user:pass@example/db']);

    const captured = sentry.captureException.mock.calls[0][0];
    expect(captured.name).toBe('TypeError');
    expect(captured.message).toBe('connect [redacted] failed');
    expect(captured.stack).not.toContain('postgres://user:pass@example/db');
    expect(captured.stack).toContain('at connect');
  });

  test('reports a thrown non-Error too', () => {
    captureHandledException('a-worker', 'store', 'plain failure');

    expect(sentry.captureException.mock.calls[0][0]).toMatchObject({ message: 'plain failure' });
  });
});

describe('redact', () => {
  test('replaces every occurrence and ignores unset secrets', () => {
    expect(redact(new Error('token abc and abc again'), 'abc', undefined)).toBe(
      'token [redacted] and [redacted] again',
    );
  });
});

describe('tagTrigger', () => {
  test('tags the invocation so triggers stay distinguishable', () => {
    tagTrigger('scheduled');

    expect(sentry.setTag).toHaveBeenCalledExactlyOnceWith('trigger', 'scheduled');
  });
});
