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
const { captureHandledException } = await import('../src/sentry.js');
const labelsCall = vi.fn();
const env = /** @type {any} */ ({
  MCP_RESOURCE: 'https://mcp.infinitywave.online/mcp',
  AUTH0_DOMAIN: 'auth.infinitywave.online',
  LABELS: { call: labelsCall },
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

const EXPECTED_TOOLS = [
  'cookie_ask_mail',
  'cookie_cancel_scheduled',
  'cookie_create_document',
  'cookie_create_event',
  'cookie_create_label',
  'cookie_create_task',
  'cookie_delete_document',
  'cookie_delete_draft',
  'cookie_delete_event',
  'cookie_delete_label',
  'cookie_delete_task',
  'cookie_get_document',
  'cookie_get_draft',
  'cookie_get_message',
  'cookie_list_calendars',
  'cookie_list_contacts',
  'cookie_list_documents',
  'cookie_list_drafts',
  'cookie_list_emails',
  'cookie_list_events',
  'cookie_list_labels',
  'cookie_list_projects',
  'cookie_list_scheduled',
  'cookie_list_tasks',
  'cookie_save_draft',
  'cookie_search_documents',
  'cookie_search_mail',
  'cookie_send_email',
  'cookie_update_document',
  'cookie_update_event',
  'cookie_update_label',
  'cookie_update_message',
  'cookie_update_task',
];

/** @param {string} method @param {Record<string, unknown>} [params] */
async function rpc(method, params = {}) {
  authenticate.mockResolvedValue({ userId: 'u-1', email: 'a@example.com' });
  const response = await worker.fetch(
    new Request('https://mcp.example/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': method,
        ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
      },
      body: JSON.stringify({
        ...TOOLS_LIST_REQUEST,
        method,
        params: { ...TOOLS_LIST_REQUEST.params, ...params },
      }),
    }),
    env,
    ctx,
  );
  if (response.status !== 200) throw new Error(await response.clone().text());
  return (await readJsonRpc(response)).result;
}

// A block body: an arrow returning the mock would hand it to vitest as a
// teardown, which then calls it after each test.
beforeEach(() => {
  authenticate.mockReset();
  labelsCall.mockReset();
  vi.mocked(captureHandledException).mockReset();
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

describe('tools', () => {
  test('lists exactly the expected tools with the right annotations', async () => {
    const { tools } = await rpc('tools/list');
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const { name, annotations } of tools) {
      const readOnly = /^cookie_(list|get|search)_/.test(name) || name === 'cookie_ask_mail';
      const destructive =
        name.startsWith('cookie_delete_') ||
        name === 'cookie_cancel_scheduled' ||
        name === 'cookie_send_email';
      expect(annotations.readOnlyHint === true, `${name} readOnlyHint`).toBe(readOnly);
      expect(annotations.destructiveHint === true, `${name} destructiveHint`).toBe(destructive);
    }
  });

  test('tools/call returns structured content from the bound Worker', async () => {
    labelsCall.mockResolvedValue({ status: 200, body: { labels: [] } });
    const result = await rpc('tools/call', { name: 'cookie_list_labels', arguments: {} });
    expect(result.structuredContent).toEqual({ labels: [] });
    expect(result.isError).toBeFalsy();
    expect(labelsCall.mock.calls[0][0]).toEqual({ userId: 'u-1', email: 'a@example.com' });
  });

  test('an API error becomes an isError result without being captured', async () => {
    labelsCall.mockResolvedValue({ status: 404, body: { error: 'x' } });
    const result = await rpc('tools/call', { name: 'cookie_list_labels', arguments: {} });
    expect(result.isError).toBe(true);
    expect(captureHandledException).not.toHaveBeenCalled();
  });

  test('an unexpected failure is captured with the tool name and returns isError', async () => {
    labelsCall.mockRejectedValue(new Error('boom'));
    const result = await rpc('tools/call', { name: 'cookie_list_labels', arguments: {} });
    expect(result.isError).toBe(true);
    expect(captureHandledException).toHaveBeenCalledWith(
      'cookie_list_labels',
      expect.any(Error),
      env,
    );
  });
});

// A 2025-era client: initialize first, then tools/list and tools/call as
// independent POSTs with no _meta claim. The SDK's stateless legacy fallback
// serves these (usually over SSE), so this guards clients that have not moved
// to the modern envelope yet.
describe('legacy (2025-era) protocol', () => {
  const LEGACY_VERSION = '2025-06-18';

  /** @param {number} id @param {string} method @param {Record<string, unknown>} params */
  async function legacyRpc(id, method, params) {
    authenticate.mockResolvedValue({ userId: 'u-1', email: 'a@example.com' });
    const response = await worker.fetch(
      new Request('https://mcp.example/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': LEGACY_VERSION }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      }),
      env,
      ctx,
    );
    if (response.status !== 200) throw new Error(await response.clone().text());
    const payload = await readJsonRpc(response);
    expect(payload.id).toBe(id);
    return payload.result;
  }

  test('initialize, tools/list and tools/call cookie_list_labels', async () => {
    const init = await legacyRpc(1, 'initialize', {
      protocolVersion: LEGACY_VERSION,
      capabilities: {},
      clientInfo: { name: 'cookie-mcp-legacy-test', version: '1.0.0' },
    });
    expect(init.protocolVersion).toBe(LEGACY_VERSION);
    expect(init.capabilities.tools).toBeDefined();

    const { tools } = await legacyRpc(2, 'tools/list', {});
    expect(tools.map((/** @type {any} */ tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);

    labelsCall.mockResolvedValue({ status: 200, body: { labels: [] } });
    const result = await legacyRpc(3, 'tools/call', { name: 'cookie_list_labels', arguments: {} });
    expect(result.structuredContent).toEqual({ labels: [] });
    expect(result.isError).toBeFalsy();
    expect(labelsCall.mock.calls[0][0]).toEqual({ userId: 'u-1', email: 'a@example.com' });
  });
});
