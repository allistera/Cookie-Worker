import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  isPublicIPv4,
  isPublicIPv6,
  requestPublicHttps,
  resolvePublicHttpsUrl,
} from './safe-https.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** @param {Record<string, string[]>} answersByHost e.g. { 'example.com|A': ['1.2.3.4'] } */
function stubDoh(answersByHost) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(String(input));
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type');
      const addresses = answersByHost[`${name}|${type}`];
      if (addresses === undefined) {
        return { ok: true, json: async () => ({ Status: 3 }) }; // NXDOMAIN
      }
      return {
        ok: true,
        json: async () => ({
          Status: 0,
          Answer: addresses.map((data) => ({ type: type === 'A' ? 1 : 28, data })),
        }),
      };
    }),
  );
}

describe('isPublicIPv4', () => {
  test('rejects private, loopback, link-local, and metadata addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '192.0.2.10',
      '192.168.1.1',
      '172.16.0.1',
    ]) {
      expect(isPublicIPv4(address)).toBe(false);
    }
  });

  test('accepts a public address', () => {
    expect(isPublicIPv4('93.184.216.34')).toBe(true);
  });
});

describe('isPublicIPv6', () => {
  test('rejects loopback, link-local, unique-local, mapped-IPv4, and documentation addresses', () => {
    for (const address of [
      '::1',
      '::ffff:127.0.0.1',
      'fe80::1',
      'fd00::1',
      '2001:db8::1',
      '2002:7f00:1::1',
      '3fff::1',
    ]) {
      expect(isPublicIPv6(address)).toBe(false);
    }
  });

  test('accepts a public address', () => {
    expect(isPublicIPv6('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });
});

describe('resolvePublicHttpsUrl', () => {
  test('rejects a non-https URL before resolving anything', async () => {
    await expect(resolvePublicHttpsUrl('http://x.example/u')).rejects.toThrow(
      /credential-free HTTPS/i,
    );
  });

  test('rejects a URL with embedded credentials', async () => {
    await expect(resolvePublicHttpsUrl('https://user:pass@x.example/u')).rejects.toThrow(
      /credential-free HTTPS/i,
    );
  });

  test('rejects a hostname whose only A record is private', async () => {
    stubDoh({ 'evil.example|A': ['169.254.169.254'] });
    await expect(resolvePublicHttpsUrl('https://evil.example/u')).rejects.toThrow(
      /disallowed address/i,
    );
  });

  test('rejects when any resolved address is non-public, even alongside a public one', async () => {
    stubDoh({ 'mixed.example|A': ['93.184.216.34', '127.0.0.1'] });
    await expect(resolvePublicHttpsUrl('https://mixed.example/u')).rejects.toThrow(
      /disallowed address/i,
    );
  });

  test('resolves when every A/AAAA record is public', async () => {
    stubDoh({ 'x.example|A': ['93.184.216.34'] });
    await expect(resolvePublicHttpsUrl('https://x.example/u')).resolves.toBeInstanceOf(URL);
  });

  test('rejects a hostname with no A or AAAA records', async () => {
    stubDoh({});
    await expect(resolvePublicHttpsUrl('https://nowhere.example/u')).rejects.toThrow(
      /could not resolve/i,
    );
  });
});

describe('requestPublicHttps', () => {
  test('never calls fetch for the real request when resolution fails', async () => {
    stubDoh({ 'evil.example|A': ['127.0.0.1'] });
    const fetchSpy = vi.mocked(fetch);
    await expect(requestPublicHttps('https://evil.example/u', { method: 'POST' })).rejects.toThrow(
      /disallowed address/i,
    );
    // Only the DNS-over-HTTPS lookups ran — no request to the target itself.
    expect(
      fetchSpy.mock.calls.every(([url]) => String(url).startsWith('https://cloudflare-dns.com/')),
    ).toBe(true);
  });

  test('makes the real request once resolution succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        if (String(input).startsWith('https://cloudflare-dns.com/')) {
          return {
            ok: true,
            json: async () => ({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }),
          };
        }
        return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }) };
      }),
    );

    const response = await requestPublicHttps('https://x.example/u', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      timeoutMs: 5000,
    });
    expect(response.status).toBe(200);
    const targetCall = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).startsWith('https://x.example'));
    expect(targetCall?.[1]).toMatchObject({ redirect: 'manual' });
  });
});

/**
 * Global fetch answering every DoH lookup with one public address and
 * handing every other request to `target`.
 *
 * @param {(url: URL, init: RequestInit) => Response | Promise<Response>} target
 */
function stubPublicTarget(target) {
  const targetMock = vi.fn(target);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') {
        return Response.json({
          Status: 0,
          Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [],
        });
      }
      return targetMock(url, init);
    }),
  );
  return targetMock;
}

describe('requestPublicHttps redirects', () => {
  test('returns a redirect to the caller when maxRedirects is not set', async () => {
    const target = stubPublicTarget(
      () => new Response(null, { status: 302, headers: { Location: 'https://other.example/' } }),
    );
    const response = await requestPublicHttps('https://x.example/u');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://other.example/');
    expect(target).toHaveBeenCalledOnce();
  });

  test('follows a redirect as a body-free GET and checks the new host again', async () => {
    const target = stubPublicTarget((url, init) => {
      if (url.pathname === '/form') {
        return new Response(null, { status: 307, headers: { Location: '/done' } });
      }
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({ Accept: 'text/html' });
      return new Response('ok');
    });
    const checkUrl = vi.fn();
    const response = await requestPublicHttps('https://x.example/form', {
      method: 'POST',
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
      maxRedirects: 3,
      maxResponseBytes: 100,
      checkUrl,
    });
    expect(response).toMatchObject({ status: 200, url: 'https://x.example/done' });
    expect(new TextDecoder().decode(response.body ?? undefined)).toBe('ok');
    expect(target).toHaveBeenCalledTimes(2);
    expect(checkUrl.mock.calls.map(([url]) => url.href)).toEqual([
      'https://x.example/form',
      'https://x.example/done',
    ]);
  });

  test('refuses a redirect to a non-https URL before requesting it', async () => {
    const target = stubPublicTarget(
      () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } }),
    );
    await expect(requestPublicHttps('https://x.example/u', { maxRedirects: 3 })).rejects.toThrow(
      /credential-free HTTPS/i,
    );
    expect(target).toHaveBeenCalledOnce();
  });

  test('stops after maxRedirects hops', async () => {
    const target = stubPublicTarget(
      () => new Response(null, { status: 302, headers: { Location: '/again' } }),
    );
    await expect(requestPublicHttps('https://x.example/u', { maxRedirects: 2 })).rejects.toThrow(
      'too_many_redirects',
    );
    expect(target).toHaveBeenCalledTimes(3);
  });

  test('lets a caller rule reject a URL before any lookup', async () => {
    const target = stubPublicTarget(() => new Response('ok'));
    await expect(
      requestPublicHttps('https://x.example/u', {
        checkUrl: () => {
          throw new Error('not_allowed');
        },
      }),
    ).rejects.toThrow('not_allowed');
    expect(fetch).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
  });
});

describe('requestPublicHttps bodies', () => {
  test('does not read the body unless maxResponseBytes is set', async () => {
    stubPublicTarget(() => new Response('ignored'));
    const response = await requestPublicHttps('https://x.example/u');
    expect(response).toMatchObject({ status: 200, body: null, truncated: false });
  });

  test('stops reading at the byte cap and reports the body as truncated', async () => {
    const cancel = vi.fn();
    stubPublicTarget(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8).fill(65));
            },
            cancel,
          }),
        ),
    );
    const response = await requestPublicHttps('https://x.example/u', { maxResponseBytes: 5 });
    expect(response.truncated).toBe(true);
    expect(response.body).toHaveLength(5);
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('sends the target request through fetchImpl and lookups through global fetch', async () => {
    stubPublicTarget(() => {
      throw new Error('the target must use fetchImpl');
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const response = await requestPublicHttps('https://x.example/u', { fetchImpl });
    expect(response.status).toBe(204);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://x.example/u',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });
});

describe('requestPublicHttps timeout', () => {
  test('aborts a request that outlives timeoutMs', async () => {
    stubPublicTarget(() => new Response('unused'));
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (/** @type {any} */ _url, /** @type {RequestInit} */ init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      const request = requestPublicHttps('https://x.example/u', {
        timeoutMs: 1000,
        fetchImpl: /** @type {any} */ (fetchImpl),
      });
      const failure = expect(request).rejects.toMatchObject({ name: 'TimeoutError' });
      await vi.advanceTimersByTimeAsync(1000);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });
});
