// Who may publish. The From header is whatever the sender typed, so matching
// it proves nothing on its own: the match only counts when Cloudflare's own
// DMARC check passed for that header's domain.

// Email Routing prepends its verdict as the first Authentication-Results
// header, under this identifier. Any later one came with the message and may
// have been written by the sender.
const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net';

/**
 * Whether Cloudflare recorded a DMARC pass for mail claiming to be from
 * `domain`. Cloudflare's header reads
 * `mx.cloudflare.net; dkim=pass ...; dmarc=pass header.from=example.com policy.dmarc=reject; spf=...`.
 *
 * @param {{key: string, value: string}[]} headers In message order, keys lower-cased.
 * @param {string} domain
 */
export function dmarcPassedFor(headers, domain) {
  const verdict = headers.find((header) => header.key === 'authentication-results');
  if (!verdict) return false;
  const [authservId, ...results] = verdict.value.split(';').map((part) => part.trim());
  if (authservId.toLowerCase() !== CLOUDFLARE_AUTHSERV_ID) return false;
  const expected = `header.from=${domain.toLowerCase()}`;
  return results.some((result) => {
    const [method, ...properties] = result.toLowerCase().split(/\s+/u);
    return method === 'dmarc=pass' && properties.includes(expected);
  });
}

/**
 * Whether the message is from `allowedSender` and authenticated as such.
 *
 * @param {{from?: {address?: string}, headers: {key: string, value: string}[]}} email A parsed message.
 * @param {string} allowedSender
 * @returns {'authorised' | 'sender_not_allowed' | 'unauthenticated'}
 */
export function checkSender(email, allowedSender) {
  const allowed = allowedSender.trim().toLowerCase();
  // DMARC covers one From header. A second one would let a client show an
  // address other than the one that was checked.
  const fromHeaders = email.headers.filter((header) => header.key === 'from');
  const address = String(email.from?.address ?? '')
    .trim()
    .toLowerCase();
  if (!allowed || fromHeaders.length !== 1 || address !== allowed) return 'sender_not_allowed';
  const domain = allowed.slice(allowed.lastIndexOf('@') + 1);
  return dmarcPassedFor(email.headers, domain) ? 'authorised' : 'unauthenticated';
}

/**
 * Why the message was sent by a machine, or null for mail a person wrote.
 * Cookie sends DMARC-aligned mail from the owner's address to addresses that
 * inbound mail chose: a calendar reply goes to the invitation's organiser, an
 * out-of-office answer to the sender. Either would pass checkSender here and
 * be published under the other party's subject.
 *
 * @param {{headers: {key: string, value: string}[], attachments?: {mimeType?: string}[]}} email A parsed message.
 * @returns {'auto_submitted' | 'calendar' | null}
 */
export function automaticMailReason(email) {
  // RFC 3834: any Auto-Submitted value but "no" marks automatic mail.
  const autoSubmitted = email.headers.some(
    (header) =>
      header.key === 'auto-submitted' && header.value.split(';')[0].trim().toLowerCase() !== 'no',
  );
  if (autoSubmitted) return 'auto_submitted';
  // PostalMime lists a text/calendar part as an attachment, inline or not.
  const calendar = (email.attachments ?? []).some(
    (attachment) => String(attachment.mimeType ?? '').toLowerCase() === 'text/calendar',
  );
  return calendar ? 'calendar' : null;
}
