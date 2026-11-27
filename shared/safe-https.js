// SSRF defence for every server-side request to a URL that comes from mail
// or user settings: one-click and AI unsubscribe, subscribed calendar feeds
// and the per-user ntfy server. Each of those Workers also sets the
// global_fetch_strictly_public compatibility flag, so a host in our own zone
// is reached through its public front door, never straight at the origin.
//
// Cookie-Web's original api/_lib/safe-https.js resolved the hostname via
// node:dns, checked every address and pinned the connection to the checked
// IP, which closes DNS rebinding. Workers' fetch() has no pinning primitive.
// This module resolves the hostname itself (Cloudflare DNS over HTTPS) and
// rejects any private or internal A/AAAA record, which blocks a domain that
// simply points inside a network. fetch() then resolves again on its own, so
// a domain re-pointed between the two lookups could still slip through.
// Callers keep that residual risk small: they send fixed or validated bodies,
// cap what they read, and re-check every redirect hop here. Callers that need
// a tighter target set add a suffix allowlist via hostMatchesSuffixes (the
// calendar Worker does) or a checkUrl rule.

const DNS_QUERY_TIMEOUT_MS = 5000;
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

const PRIVATE_IPV4_RANGES = /** @type {[string, number][]} */ ([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);

/** @param {string} ip */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

/** @param {string} ip */
export function isPublicIPv4(ip) {
  const int = ipv4ToInt(ip);
  return !PRIVATE_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (int & mask) === (ipv4ToInt(base) & mask);
  });
}

/**
 * Expands an IPv6 address (including "::" compression) into its 8 16-bit
 * groups, as numbers.
 *
 * @param {string} address
 */
function expandIPv6Groups(address) {
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  /** @type {string[]} */
  let groups;
  if (address.includes('::')) {
    const missing = Math.max(8 - headGroups.length - tailGroups.length, 0);
    groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  } else {
    groups = address.split(':');
  }
  return groups.map((group) => Number.parseInt(group || '0', 16));
}

/**
 * @param {string} address
 * @param {string} prefixAddress
 * @param {number} prefixBits
 */
function ipv6InPrefix(address, prefixAddress, prefixBits) {
  const groups = expandIPv6Groups(address);
  const prefixGroups = expandIPv6Groups(prefixAddress);
  let bitsLeft = prefixBits;
  for (let i = 0; i < 8 && bitsLeft > 0; i += 1) {
    const bits = Math.min(16, bitsLeft);
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if (((groups[i] ?? 0) & mask) !== ((prefixGroups[i] ?? 0) & mask)) return false;
    bitsLeft -= bits;
  }
  return true;
}

// Teredo (2001::/23), documentation (2001:db8::/32, 3fff::/20), and 6to4
// (2002::/16) — reserved/transitional ranges, not internal-network-reachable
// space, but excluded for parity with the original's BlockList.
const BLOCKED_IPV6_RANGES = /** @type {[string, number][]} */ ([
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['64:ff9b::', 96],
]);

/** @param {string} address */
export function isPublicIPv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  // Globally routable unicast addresses currently occupy 2000::/3. Checking
  // just the first hex group against that range fails closed for loopback,
  // unspecified, link-local, unique-local, and multicast addresses.
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  return !BLOCKED_IPV6_RANGES.some(([prefix, bits]) => ipv6InPrefix(normalized, prefix, bits));
}

/**
 * @param {string} hostname
 * @param {'A' | 'AAAA'} type
 */
async function resolveDnsRecords(hostname, type) {
  const url = new URL(DOH_ENDPOINT);
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', type);
  const response = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DNS_QUERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('DNS resolution failed');
  const data = /** @type {{Status: number, Answer?: {type: number, data: string}[]}} */ (
    await response.json()
  );
  if (data.Status !== 0) return [];
  const recordType = type === 'A' ? 1 : 28;
  return (data.Answer ?? [])
    .filter((record) => record.type === recordType)
    .map((record) => record.data);
}

/**
 * @param {string | URL} rawUrl
 */
export async function resolvePublicHttpsUrl(rawUrl) {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Only credential-free HTTPS URLs are allowed');
  }

  let aRecords;
  let aaaaRecords;
  try {
    [aRecords, aaaaRecords] = await Promise.all([
      resolveDnsRecords(url.hostname, 'A'),
      resolveDnsRecords(url.hostname, 'AAAA'),
    ]);
  } catch {
    throw new Error('Could not resolve the remote URL');
  }
  if (aRecords.length === 0 && aaaaRecords.length === 0) {
    throw new Error('Could not resolve the remote URL');
  }
  if (!aRecords.every(isPublicIPv4) || !aaaaRecords.every(isPublicIPv6)) {
    throw new Error('The remote URL points to a disallowed address');
  }

  return url;
}

/**
 * Suffix match for optional per-caller host allowlists (the calendar sync
 * uses this to pin feed URLs to configured providers).
 * @param {string} hostname @param {string[]} suffixes
 */
export function hostMatchesSuffixes(hostname, suffixes) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/u, '');
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** @param {Record<string, string>} headers */
function withoutContentType(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'),
  );
}

/**
 * Reads at most maxBytes of a body. Reading stops once the cap is reached, so
 * a body that never ends cannot hold the request open.
 *
 * @param {Response} response
 * @param {number} maxBytes
 */
async function readCappedBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { body: new Uint8Array(0), truncated: false };
  const chunks = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (received >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const body = new Uint8Array(Math.min(received, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, body.byteLength - offset);
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { body, truncated };
}

/**
 * The one way Workers fetch a URL taken from mail or user settings. Every hop
 * must be a credential-free https URL whose host resolves only to public
 * addresses, and passes the caller's own checkUrl rule when given. Redirects
 * are never followed by fetch() itself: with maxRedirects 0 (the default) a
 * 3xx comes back to the caller, otherwise each Location is validated again
 * and requested as a body-free GET. One timeout covers every hop and the
 * body read. The body is read only when maxResponseBytes is set, and never
 * past that many bytes.
 *
 * @param {string | URL} rawUrl
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string | null,
 *   timeoutMs?: number,
 *   maxRedirects?: number,
 *   maxResponseBytes?: number,
 *   checkUrl?: (url: URL) => void,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<{status: number, headers: Headers, url: string, body: Uint8Array | null, truncated: boolean}>}
 */
export async function requestPublicHttps(rawUrl, options = {}) {
  const {
    timeoutMs = 10_000,
    maxRedirects = 0,
    maxResponseBytes,
    checkUrl,
    fetchImpl = fetch,
  } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  let method = options.method ?? 'GET';
  let headers = options.headers ?? {};
  let body = options.body ?? null;
  let current = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  for (let hop = 0; ; hop += 1) {
    checkUrl?.(current);
    const url = await resolvePublicHttpsUrl(current);
    const response = await fetchImpl(url.href, {
      method,
      headers,
      body: body ?? undefined,
      redirect: 'manual',
      signal,
    });
    const location =
      response.status >= 300 && response.status < 400 ? response.headers.get('Location') : null;
    if (location && maxRedirects > 0) {
      if (hop >= maxRedirects) throw new Error('too_many_redirects');
      current = new URL(location, url);
      method = 'GET';
      headers = withoutContentType(headers);
      body = null;
      continue;
    }
    const read =
      maxResponseBytes === undefined
        ? { body: null, truncated: false }
        : await readCappedBody(response, maxResponseBytes);
    return { status: response.status, headers: response.headers, url: url.href, ...read };
  }
}
