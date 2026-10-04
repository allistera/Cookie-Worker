import { describe, expect, test, vi } from 'vitest';
import { createInternalEntrypoint } from './internal-entrypoint.js';
import { internalCaller } from './internal-identity.js';

const identity = { userId: 'u-1', email: 'a@example.com' };

function entrypointFor(fetch) {
  const Internal = createInternalEntrypoint({ fetch });
  return new Internal(/** @type {any} */ ({ waitUntil: vi.fn() }), /** @type {any} */ ({ X: 1 }));
}

describe('Internal entrypoint', () => {
  test('runs the worker inside the identity scope and returns status and JSON', async () => {
    const fetch = vi.fn(async (request) => {
      expect(internalCaller()).toEqual(identity);
      expect(request.method).toBe('PATCH');
      expect(new URL(request.url).pathname + new URL(request.url).search).toBe('/labels?x=1');
      expect(await request.json()).toEqual({ id: 'l-1' });
      return Response.json({ ok: true }, { status: 201 });
    });
    const result = await entrypointFor(fetch).call(identity, {
      method: 'PATCH',
      path: '/labels?x=1',
      body: { id: 'l-1' },
    });
    expect(result).toEqual({ status: 201, body: { ok: true } });
    expect(/** @type {any[]} */ (fetch.mock.calls[0])[1]).toEqual({ X: 1 });
  });

  test('a 204 or non-JSON body becomes null', async () => {
    const result = await entrypointFor(async () => new Response(null, { status: 204 })).call(
      identity,
      {
        method: 'DELETE',
        path: '/drafts/d-1',
      },
    );
    expect(result).toEqual({ status: 204, body: null });
  });

  test('refuses paths that are not absolute API paths', async () => {
    const entry = entrypointFor(vi.fn());
    await expect(
      entry.call(identity, { method: 'GET', path: 'https://evil.example/' }),
    ).rejects.toThrow();
    await expect(
      entry.call(identity, { method: 'GET', path: '//evil.example/x' }),
    ).rejects.toThrow();
  });

  test('refuses unknown methods', async () => {
    await expect(
      entrypointFor(vi.fn()).call(identity, { method: 'TRACE', path: '/x' }),
    ).rejects.toThrow();
  });
});
