import { beforeEach, describe, expect, test, vi } from 'vitest';

const authenticate = vi.fn();
vi.mock('../src/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  authenticate: (...args) => authenticate(...args),
}));
vi.mock('../src/sentry.js', () => ({
  createSentryOptions: () => ({ enabled: false }),
  captureHandledException: vi.fn(),
}));

const worker = (await import('../src/worker.js')).default;
const env = /** @type {any} */ ({
  MCP_RESOURCE: 'https://mcp.infinitywave.online/mcp',
  AUTH0_DOMAIN: 'auth.infinitywave.online',
});
const ctx = /** @type {any} */ ({ waitUntil: () => undefined });

// A 2026-07-28 ("modern") request: the protocol version, client info and
// client capabilities ride in params._meta on every request, so the stateless
// handler serves it without an initialize round trip. The SDK routes on that
// _meta claim, then requires MCP-Protocol-Version and Mcp-Method headers that
// match the body (-32020 otherwise). The 2025-era stateless fallback would
// also answer a bare tools/list (over SSE), but the modern path is the one
// current clients negotiate.
const PROTOCOL_VERSION = '2026-07-28';
const TOOLS_LIST_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'cookie-mcp-test', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
};

/**
 * The handler answers in JSON, but an SSE body (first `data:` line) is
 * accepted too so the test does not depend on the response mode.
 *
 * @param {Response} response
 */
async function readJsonRpc(response) {
  const text = await response.text();
  if (!response.headers.get('Content-Type')?.includes('text/event-stream')) return JSON.parse(text);
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(String(data).slice('data:'.length));
}

// A block body: an arrow returning the mock would hand it to vitest as a
// teardown, which then calls it after each test.
beforeEach(() => {
  authenticate.mockReset();
});

describe('routing', () => {
  test.each(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])(
    'serves protected resource metadata at %s without auth',
    async (path) => {
      const response = await worker.fetch(new Request(`https://mcp.example${path}`), env, ctx);
      expect(response.status).toBe(200);
      expect((await response.json()).resource).toBe('https://mcp.infinitywave.online/mcp');
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  test('unknown paths are 404', async () => {
    const response = await worker.fetch(new Request('https://mcp.example/nope'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('/mcp returns the auth challenge when authentication fails', async () => {
    authenticate.mockResolvedValue(
      new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer x' } }),
    );
    const response = await worker.fetch(
      new Request('https://mcp.example/mcp', { method: 'POST' }),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
  });

  test('an authenticated tools/list lists every cookie_ tool', async () => {
    authenticate.mockResolvedValue({ userId: 'u-1', email: 'a@example.com' });
    const response = await worker.fetch(
      new Request('https://mcp.example/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify(TOOLS_LIST_REQUEST),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    const payload = await readJsonRpc(response);
    expect(Array.isArray(payload.result.tools)).toBe(true);
    expect(payload.result.tools.every((tool) => tool.name.startsWith('cookie_'))).toBe(true);
  });
});
