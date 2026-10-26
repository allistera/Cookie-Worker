// Date-only inclusive windows are compared in their IANA zone, never as 24-hour
// arithmetic. This naturally includes both repeated DST hours and short days.
export const OUT_OF_OFFICE_COOLDOWN_DAYS = 4;
export const OUT_OF_OFFICE_RETRY_HOURS = 23;

/**
 * Serializes responder dispatch with config and post-ingest suppression changes.
 * The two-int advisory namespace cannot overlap ingest's one-bigint namespace.
 * Always acquire this BEFORE any ingest-owner/user/message locks. Ingest itself
 * must never take it: initial suppression is part of its uncommitted insert.
 * @param {import('postgres').TransactionSql} tx @param {string} userId
 */
export async function lockOutOfOfficeDispatch(tx, userId) {
  await tx`SELECT pg_advisory_xact_lock(hashtext('cookie.out-of-office'), hashtext(${userId}))`;
}

/** @param {string} value @param {boolean} [multiline] */
export function hasUnsafeControls(value, multiline = false) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
  });
}

/** @param {unknown} value */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** @param {unknown} value */
export function isTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || /^[+-]/.test(value))
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** @param {Date | string | number} instant @param {string} timeZone */
export function localDate(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  return ['year', 'month', 'day']
    .map((type) => parts.find((p) => p.type === type)?.value)
    .join('-');
}

/** @param {any} value @returns {string | null} */
export function outOfOfficeError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Invalid settings.';
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.revision >= Number.MAX_SAFE_INTEGER
  )
    return 'Invalid settings revision.';
  if (typeof value.enabled !== 'boolean') return 'Choose whether out of office is enabled.';
  if (!isCalendarDate(value.startDate) || !isCalendarDate(value.endDate))
    return 'Choose real start and end dates.';
  if (value.endDate < value.startDate) return 'End date must be on or after the start date.';
  if (!isTimeZone(value.timeZone)) return 'Choose a valid IANA timezone.';
  if (
    typeof value.subject !== 'string' ||
    !value.subject.trim() ||
    new TextEncoder().encode(value.subject).length > 998 ||
    hasUnsafeControls(value.subject)
  )
    return 'Enter a subject of at most 998 bytes without control characters.';
  if (
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    value.text.length > 10000 ||
    hasUnsafeControls(value.text, true)
  )
    return 'Enter a plain-text message of at most 10,000 characters.';
  return null;
}

/** @param {any} value */
export function outOfOfficeSettings(value) {
  const defaults = {
    revision: 0,
    enabled: false,
    startDate: '',
    endDate: '',
    timeZone: 'UTC',
    subject: 'Out of office',
    text: '',
    activatedAt: null,
  };
  if (outOfOfficeError(value)) {
    // End now also works before the first configured message; keep its revision
    // even though the safely disabled draft has no dates/body yet.
    return {
      ...defaults,
      revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
    };
  }
  return {
    revision: value.revision,
    enabled: value.enabled,
    startDate: value.startDate,
    endDate: value.endDate,
    timeZone: value.timeZone,
    subject: value.subject,
    text: value.text,
    activatedAt: typeof value.activatedAt === 'string' ? value.activatedAt : null,
  };
}

/** @param {any} settings @param {Date | string | number} [now] */
export function outOfOfficeStatus(settings, now = new Date()) {
  if (!settings.enabled || outOfOfficeError(settings)) return 'disabled';
  const day = localDate(now, settings.timeZone);
  if (day < settings.startDate) return 'scheduled';
  return day > settings.endDate ? 'expired' : 'active';
}

/** @param {unknown} value */
export function normaliseAddress(value) {
  const address = String(value ?? '')
    .trim()
    .toLowerCase();
  // Deliberately one bare address: do not follow an untrusted Reply-To or list.
  if (
    address.length > 320 ||
    !/^[a-z0-9!#$%&'*+/=?^_`{|}.-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      address,
    )
  )
    return null;
  return address;
}

/** @param {string} configuredFrom */
export function senderIdentity(configuredFrom) {
  return normaliseAddress(/<([^<>]+)>\s*$/.exec(configuredFrom)?.[1] ?? configuredFrom);
}

/**
 * The first header with this name (case-insensitive), or null. Stored headers
 * are the {key, value} entries parse.js keeps.
 * @param {unknown} headers
 * @param {string} name
 * @returns {string | null}
 */
function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const entry = headers.find(
    (header) => typeof header?.key === 'string' && header.key.toLowerCase() === name,
  );
  return typeof entry?.value === 'string' ? entry.value : null;
}

/**
 * The one mailbox a header names, reduced to its bare address. Display names and
 * comments are dropped. A list of several addresses, or anything that is not a
 * single valid address, names no reply target.
 * @param {string | null} value
 * @returns {string | null}
 */
function singleMailboxAddress(value) {
  if (value === null) return null;
  const text = value.replace(/\([^()]*\)/g, ' ').trim();
  const angled = [...text.matchAll(/<([^<>]*)>/g)].map((match) => match[1].trim());
  if (angled.length > 1 || (angled.length === 0 && text.includes(','))) return null;
  return normaliseAddress(angled.length === 1 ? angled[0] : text);
}

/**
 * Where an automatic reply goes: the address in the From header. The envelope
 * sender is never used. Behind Gmail forwarding it is Gmail's rewrite address
 * rather than the sender's.
 *
 * Reply-To is deliberately not followed. It is not covered by the sender's DKIM
 * signature unless the sender signs it, so following it would let an
 * unauthenticated header choose where an automatic reply is delivered.
 * @param {unknown} headers
 * @returns {string | null}
 */
export function replyTargetAddress(headers) {
  return singleMailboxAddress(headerValue(headers, 'from'));
}

/** @param {any} message @param {any} settings @param {string} from @param {Date | string | number} now */
export function autoReplySuppression(message, settings, from, now) {
  if (outOfOfficeStatus(settings, now) !== 'active') return 'inactive';
  if (
    Number(message.out_of_office_revision) !== settings.revision ||
    !message.out_of_office_revision
  )
    return 'revision_changed';
  const received = new Date(message.created_at).getTime();
  const activated = new Date(settings.activatedAt ?? '').getTime();
  if (
    !Number.isFinite(received) ||
    !Number.isFinite(activated) ||
    received < activated ||
    received > new Date(now).getTime()
  )
    return 'outside_activation';
  if (outOfOfficeStatus(settings, received) !== 'active') return 'outside_window';
  if (message.is_sent || message.is_deleted) return 'not_inbound';
  // Screening/blocking must set this before it becomes visible to the user.
  if (
    message.auto_reply_suppressed ||
    (message.screening_status && message.screening_status !== 'allowed')
  )
    return 'screened';
  if (message.ai_status !== 'completed' || message.spam_verdict !== 'inbox')
    return 'unclassified_or_spam';
  // Unknown header representation is not evidence of eligibility.
  if (!Array.isArray(message.headers)) return 'missing_headers';
  for (const header of message.headers) {
    if (typeof header?.key !== 'string' || typeof header?.value !== 'string')
      return 'invalid_headers';
  }
  // The reply goes to the address the sender named in the headers, never to the
  // envelope sender (see replyTargetAddress).
  const target = replyTargetAddress(message.headers);
  const author = normaliseAddress(message.from_address);
  if (!target || !author) return 'invalid_or_null_sender';
  // Mail must be addressed to the owner: To or Cc names the owner's own address
  // (users.email) or the address it was delivered to (envelope_to, which Gmail
  // forwarding does not keep in To). Bcc-only mail must not expose the mailbox via
  // an automatic reply, and no ownership is invented from a spoofable header alone.
  const owned = new Set(
    [normaliseAddress(message.owner_email), normaliseAddress(message.envelope_to)].filter(Boolean),
  );
  const visibleRecipients = ['to', 'cc'].flatMap((kind) =>
    Array.isArray(message.recipients?.[kind]) ? message.recipients[kind] : [],
  );
  if (!visibleRecipients.some((entry) => owned.has(normaliseAddress(entry?.address))))
    return 'not_addressed_to_mailbox';
  const self = new Set(
    [
      normaliseAddress(message.owner_email),
      normaliseAddress(message.envelope_to),
      senderIdentity(from),
    ].filter(Boolean),
  );
  if (!senderIdentity(from) || self.has(target) || self.has(author)) return 'self';
  if (
    /^(?:mailer-daemon|postmaster|no[._-]?reply|do[._-]?not[._-]?reply)(?:[+.-]|@)/i.test(target) ||
    /^(?:mailer-daemon|postmaster|no[._-]?reply|do[._-]?not[._-]?reply)(?:[+.-]|@)/i.test(author)
  )
    return 'automated_sender';
  for (const header of message.headers) {
    const key = header.key.toLowerCase();
    const value = header.value.trim().toLowerCase();
    if (
      key.startsWith('list-') ||
      [
        'mailing-list',
        'x-mailing-list',
        'x-loop',
        'x-autoreply',
        'x-autorespond',
        'x-auto-reply',
        'x-autoreply-from',
      ].includes(key)
    )
      return 'list_or_loop';
    if (key === 'auto-submitted' && value !== 'no') return 'automated';
    if (key === 'x-auto-response-suppress' && !['no', 'none'].includes(value))
      return 'suppressed_header';
    if (key === 'precedence' && /\b(?:bulk|list|junk|auto_reply)\b/.test(value)) return 'bulk';
    if (key === 'content-type' && /multipart\/report|message\/delivery-status/.test(value))
      return 'delivery_report';
    if (key === 'return-path' && (!value || value === '<>')) return 'null_return_path';
  }
  return null;
}
