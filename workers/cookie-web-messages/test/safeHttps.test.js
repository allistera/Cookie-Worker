import { afterEach, describe, expect, test, vi } from 'vitest';
import { isPublicIPv4, isPublicIPv6, requestPublicHttps, resolvePublicHttpsUrl } from '../src/safeHttps.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** @param {Record<string, string[]>} answersByHost e.g. { 'example.com|A': ['1.2.3.4'] } */
function stubDoh(answersByHost) {
  vi.stubGlobal('fetch', vi.fn(async (input) => {
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
  }));
}

describe('isPublicIPv4', () => {
  test('rejects private, loopback, link-local, and metadata addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.0.2.10', '192.168.1.1', '172.16.0.1']) {
      expect(isPublicIPv4(address)).toBe(false);
    }
  });

  test('accepts a public address', () => {
    expect(isPublicIPv4('93.184.216.34')).toBe(true);
  });
});

describe('isPublicIPv6', () => {
  test('rejects loopback, link-local, unique-local, mapped-IPv4, and documentation addresses', () => {
    for (const address of ['::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', '2001:db8::1', '2002:7f00:1::1', '3fff::1']) {
      expect(isPublicIPv6(address)).toBe(false);
    }
  });

  test('accepts a public address', () => {
    expect(isPublicIPv6('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });
});

describe('resolvePublicHttpsUrl', () => {
  test('rejects a non-https URL before resolving anything', async () => {
    await expect(resolvePublicHttpsUrl('http://x.example/u')).rejects.toThrow(/credential-free HTTPS/i);
  });

  test('rejects a URL with embedded credentials', async () => {
    await expect(resolvePublicHttpsUrl('https://user:pass@x.example/u')).rejects.toThrow(/credential-free HTTPS/i);
  });

  test('rejects a hostname whose only A record is private', async () => {
    stubDoh({ 'evil.example|A': ['169.254.169.254'] });
    await expect(resolvePublicHttpsUrl('https://evil.example/u')).rejects.toThrow(/disallowed address/i);
  });

  test('rejects when any resolved address is non-public, even alongside a public one', async () => {
    stubDoh({ 'mixed.example|A': ['93.184.216.34', '127.0.0.1'] });
    await expect(resolvePublicHttpsUrl('https://mixed.example/u')).rejects.toThrow(/disallowed address/i);
  });

  test('resolves when every A/AAAA record is public', async () => {
    stubDoh({ 'x.example|A': ['93.184.216.34'] });
    await expect(resolvePublicHttpsUrl('https://x.example/u')).resolves.toBeInstanceOf(URL);
  });

  test('rejects a hostname with no A or AAAA records', async () => {
    stubDoh({});
    await expect(resolvePublicHttpsUrl('https://nowhere.example/u')).rejects.toThrow(/could not resolve/i);
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
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith('https://cloudflare-dns.com/'))).toBe(true);
  });

  test('makes the real request once resolution succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).startsWith('https://cloudflare-dns.com/')) {
        return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }) };
      }
      return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }) };
    }));

    const response = await requestPublicHttps('https://x.example/u', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      timeoutMs: 5000,
    });
    expect(response.status).toBe(200);
    const targetCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith('https://x.example'));
    expect(targetCall?.[1]).toMatchObject({ redirect: 'manual' });
  });
});
