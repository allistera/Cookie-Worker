// SSRF defense for the one-click unsubscribe POST — a server-side request to
// a URL taken from an untrusted, sender-controlled email header.
//
// Cookie-Web's original api/_lib/safe-https.js resolves the hostname itself
// via node:dns, verifies every resolved address is public, and then pins the
// actual HTTPS connection to that exact verified IP (Node's
// https.request({ lookup })) — closing a DNS-rebinding attack, where a
// malicious domain answers with a safe IP for the check and a private one
// moments later for the real connection.
//
// Workers' fetch() has no equivalent pinning primitive: there is no way to
// force the connection fetch() itself makes to reuse an IP this module
// already resolved and checked. This module still resolves the hostname
// itself first (via Cloudflare's DNS-over-HTTPS resolver) and rejects if any
// A/AAAA record is private/internal — that blocks the common case, a domain
// that simply points at an internal address. It does NOT close the narrower,
// timing-dependent DNS-rebinding gap on its own: fetch() re-resolves
// independently, so a domain re-pointed between our check and fetch()'s own
// resolution could still slip through. Callers accept that residual risk by
// keeping the request itself inert: requestPublicHttps sends a caller-fixed
// body, follows no redirects, and exposes only the status and headers — the
// response body never reaches a client. Callers that need a tighter target
// set can still layer a suffix allowlist via hostMatchesSuffixes (the
// calendar worker does).

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

/**
 * @param {string | URL} rawUrl
 * @param {{method?: string, headers?: Record<string, string>, body?: string | null, timeoutMs?: number}} [options]
 */
export async function requestPublicHttps(rawUrl, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 10_000 } = options;
  const url = await resolvePublicHttpsUrl(rawUrl);
  const response = await fetch(url, {
    method,
    headers,
    body: body ?? undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, headers: response.headers };
}
