import { expect, test, vi } from 'vitest';

// Only the database and Sentry are stubbed: the point is to exercise the real
// verifyAccessToken so the internal-caller bypass is proven end to end.
const mockQuery = vi.fn(
  /** @param {any[]} _args */ (..._args) => Promise.resolve(/** @type {any[]} */ ([])),
);
vi.mock('postgres', () => ({
  default: () => {
    /** @type {any} */
    const sql = (/** @type {any[]} */ ...args) => mockQuery(...args);
    sql.begin = async (/** @type {(sql: any) => unknown} */ callback) => callback(sql);
    sql.end = async () => undefined;
    return sql;
  },
}));

vi.mock('../src/sentry.js', () => ({
  createSentryOptions: () => ({ enabled: false }),
  captureHandledException: vi.fn(),
}));

const { createInternalEntrypoint } = await import('../../../shared/internal-entrypoint.js');
const worker = (await import('../src/worker.js')).default;

test('Internal.call serves GET /labels for the scoped user without a token', async () => {
  mockQuery.mockResolvedValueOnce([{ id: 'l-1', name: 'Finance', color: '#112233', kind: 'user' }]);
  const Internal = createInternalEntrypoint(worker);
  const entry = new Internal(
    /** @type {any} */ ({ waitUntil: () => undefined }),
    /** @type {any} */ ({
      HYPERDRIVE: { connectionString: 'postgres://stub' },
      AUTH0_DOMAIN: 'tenant.example.auth0.com',
      AUTH0_AUDIENCE: 'https://cookie-web/api',
      ALLOWED_ORIGIN: 'https://mail.infinitywave.online',
    }),
  );
  const result = await entry.call(
    { userId: 'user-9', email: 'a@example.com' },
    { method: 'GET', path: '/labels' },
  );
  expect(result.status).toBe(200);
  expect(mockQuery.mock.calls.some((call) => call.includes('user-9'))).toBe(true);
});
