// Parsing and SSRF-hardening for the email unsubscribe feature. Ported
// verbatim from Cookie-Web's api/_lib/unsubscribe.js and
// src/lib/isSafeUnsubscribeUrl.js — both are pure JS with no Node-specific
// APIs, so nothing changes for Workers.
//
// `messages.headers` is sender-controlled, untrusted jsonb: an array of
// { key, value } objects preserving original header casing. Everything here
// treats that input as hostile — malformed shapes and malformed URIs are
// skipped, never thrown.

/**
 * Shared policy for unsubscribe URLs exposed in app chrome or fetched by the
 * server. Sender-controlled targets must be public HTTPS URLs with no
 * embedded credentials or non-default port. This is a syntactic check only —
 * it rejects raw IP literals and known-internal suffixes, but says nothing
 * about where a legitimate-looking domain name actually resolves. That's
 * safeHttps.js's job, for the one case (server-side one-click POST) that
 * actually connects to the URL.
 *
 * @param {any} url Sender-controlled — may be anything, not just a string.
 */
export function isSafeUnsubscribeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port !== '') {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') || host.endsWith(']')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (!host.includes('.')) return false;

  const labels = host.split('.');
  if (/^\d+$/.test(labels.at(-1) ?? '')) return false;

  const blockedSuffixes = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];
  return !blockedSuffixes.some((suffix) => host.endsWith(suffix));
}

/**
 * Reads the RFC 2369 `List-Unsubscribe` header (comma-separated <uri>
 * entries) and the RFC 8058 `List-Unsubscribe-Post` header. Returns the
 * first http(s) URI and the first mailto: URI found, plus whether one-click
 * POST is offered.
 *
 * Returns null when there is no usable URI, else:
 *   { oneClick: boolean, url: string|null, mailto: { address, subject }|null }
 * oneClick is only true when List-Unsubscribe-Post signals One-Click AND
 * there is an http(s) url to POST to.
 *
 * @param {any} headers
 */
export function parseListUnsubscribe(headers) {
  if (!Array.isArray(headers)) return null;

  const findHeader = (/** @type {string} */ name) => {
    const lower = name.toLowerCase();
    for (const entry of headers) {
      if (String(entry?.key ?? '').toLowerCase() !== lower) continue;
      if (entry.value === null || entry.value === undefined) continue;
      return String(entry.value);
    }
    return null;
  };

  const listUnsub = findHeader('List-Unsubscribe');
  const listUnsubPost = findHeader('List-Unsubscribe-Post');

  /** @type {string | null} */
  let url = null;
  /** @type {{address: string, subject: string | null} | null} */
  let mailto = null;

  if (listUnsub) {
    // RFC 2369 wraps each URI in angle brackets: <uri>, <uri>, ...
    const bracketed = listUnsub.match(/<([^>]*)>/g) || [];
    for (const raw of bracketed) {
      const uri = raw.slice(1, -1).trim();
      if (!uri) continue;
      /** @type {URL} */
      let parsed;
      try {
        parsed = new URL(uri);
      } catch {
        continue; // malformed URI — skip, never throw
      }
      const protocol = parsed.protocol.toLowerCase();
      if ((protocol === 'http:' || protocol === 'https:') && url === null) {
        url = uri;
      } else if (protocol === 'mailto:' && mailto === null) {
        const address = parsed.pathname.trim();
        if (!address) continue;
        const subject = parsed.searchParams.get('subject');
        mailto = { address, subject: subject && subject.length ? subject : null };
      }
    }
  }

  const oneClick = Boolean(
    listUnsubPost &&
      listUnsubPost.trim().toLowerCase() === 'list-unsubscribe=one-click' &&
      url,
  );

  if (url === null && mailto === null) return null;
  return { oneClick, url, mailto };
}
