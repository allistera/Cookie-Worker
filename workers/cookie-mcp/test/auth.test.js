import { beforeEach, describe, expect, test, vi } from 'vitest';

const verifyAccessToken = vi.fn();
vi.mock('../../../shared/auth-jwt.js', async (importOriginal) => ({
  ...(await importOriginal()),
  verifyAccessToken: (...args) => verifyAccessToken(...args),
}));
vi.mock('postgres', () => ({
  default: () => Object.assign(vi.fn(), { end: vi.fn(async () => undefined) }),
}));

const { AuthFailure } = await import('../../../shared/auth-jwt.js');
const { authenticate, protectedResourceMetadata, METADATA_PATHS } = await import('../src/auth.js');

const env = /** @type {any} */ ({
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  AUTH0_DOMAIN: 'auth.infinitywave.online',
  AUTH0_AUDIENCE: 'https://mcp.infinitywave.online/mcp',
  MCP_RESOURCE: 'https://mcp.infinitywave.online/mcp',
});
const ctx = /** @type {any} */ ({ waitUntil: () => undefined });

// A block body: an arrow returning the mock would hand it to vitest as a
// teardown, which then calls it after each test.
beforeEach(() => {
  verifyAccessToken.mockReset();
});

describe('protected resource metadata', () => {
  test('names the resource and Auth0 as its authorization server', () => {
    expect(protectedResourceMetadata(env)).toEqual({
      resource: 'https://mcp.infinitywave.online/mcp',
      authorization_servers: ['https://auth.infinitywave.online/'],
      bearer_methods_supported: ['header'],
      resource_name: 'Cookie',
    });
    expect(METADATA_PATHS).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
  });
});

describe('authenticate', () => {
  test('missing or invalid tokens get a 401 challenge pointing at the metadata', async () => {
    verifyAccessToken.mockRejectedValue(new AuthFailure('Missing bearer token', 401));
    const response = /** @type {Response} */ (
      await authenticate(new Request('https://mcp.example/mcp'), env, ctx)
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.infinitywave.online/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test('an unprovisioned subject gets 403 insufficient_scope-free forbidden', async () => {
    verifyAccessToken.mockRejectedValue(new AuthFailure('not provisioned', 403));
    const response = /** @type {Response} */ (
      await authenticate(new Request('https://mcp.example/mcp'), env, ctx)
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
  });

  test('verifies against the MCP audience and returns the identity', async () => {
    verifyAccessToken.mockResolvedValue({ userId: 'u-1', email: 'a@example.com' });
    const identity = await authenticate(
      new Request('https://mcp.example/mcp', { headers: { Authorization: 'Bearer t' } }),
      env,
      ctx,
    );
    expect(identity).toEqual({ userId: 'u-1', email: 'a@example.com' });
    expect(verifyAccessToken.mock.calls[0][1].AUTH0_AUDIENCE).toBe(
      'https://mcp.infinitywave.online/mcp',
    );
  });

  test('auth outages are 503 without a challenge', async () => {
    verifyAccessToken.mockRejectedValue(new AuthFailure('down', 503));
    const response = /** @type {Response} */ (
      await authenticate(new Request('https://mcp.example/mcp'), env, ctx)
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });
});
