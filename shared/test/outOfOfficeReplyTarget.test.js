import { describe, expect, test } from 'vitest';
import { autoReplySuppression, replyTargetAddress } from '../outOfOffice.js';

const settings = {
  revision: 1,
  enabled: true,
  startDate: '2026-10-25',
  endDate: '2026-10-25',
  timeZone: 'Europe/London',
  subject: 'Away',
  text: 'I will reply when I return.',
  activatedAt: '2026-10-24T10:00:00Z',
};
const from = 'Cookie <mail@example.com>';
const now = '2026-10-25T12:00:00Z';

// Gmail auto-forwarding: From is the original sender, To is the owner's own Gmail
// address, envelope_to is the alias the mail was delivered to, and the envelope
// sender is Gmail's +caf_ rewrite address rather than the sender's.
const gmailForwarded = {
  id: 'message',
  created_at: '2026-10-25T01:15:00Z',
  out_of_office_revision: 1,
  from_address: 'alice@example.com',
  envelope_from: 'allisteraall+caf_=alice=example.com@gmail.com',
  envelope_to: 'helloo@allisterantosik.com',
  recipients: { to: [{ address: 'allisteraall@gmail.com' }], cc: [] },
  owner_email: 'allisteraall@gmail.com',
  headers: [
    { key: 'From', value: 'Alice <alice@example.com>' },
    { key: 'To', value: 'Allister <allisteraall@gmail.com>' },
  ],
  ai_status: 'completed',
  spam_verdict: 'inbox',
  is_sent: false,
  is_deleted: false,
};

/** @param {Record<string, unknown>} [changes] */
const reason = (changes = {}) =>
  autoReplySuppression({ ...gmailForwarded, ...changes }, settings, from, now);

describe('reply target for Gmail-forwarded mail', () => {
  test('replies to the From address and does not suppress the reply', () => {
    expect(replyTargetAddress(gmailForwarded.headers)).toBe('alice@example.com');
    expect(reason()).toBeNull();
  });

  test('never falls back to the envelope sender when the headers name no sender', () => {
    expect(reason({ headers: [{ key: 'To', value: 'Allister <allisteraall@gmail.com>' }] })).toBe(
      'invalid_or_null_sender',
    );
  });

  test('ignores Reply-To, which an unauthenticated header can set', () => {
    const headers = [
      { key: 'Reply-To', value: 'Desk <desk@example.com>' },
      ...gmailForwarded.headers,
    ];
    expect(replyTargetAddress(headers)).toBe('alice@example.com');
    expect(reason({ headers })).toBeNull();
  });

  test('reads one address out of a display name and comments', () => {
    expect(
      replyTargetAddress([{ key: 'From', value: '"Doe, Jane" (work) <Jane@Example.com>' }]),
    ).toBe('jane@example.com');
  });
});

describe('addressed to the owner', () => {
  test('accepts the envelope alias in Cc when To does not name the owner', () => {
    expect(
      reason({ recipients: { to: [], cc: [{ address: 'helloo@allisterantosik.com' }] } }),
    ).toBeNull();
  });

  test('refuses Bcc-only mail, even when it names the owner', () => {
    expect(
      reason({ recipients: { to: [], cc: [], bcc: [{ address: 'allisteraall@gmail.com' }] } }),
    ).toBe('not_addressed_to_mailbox');
  });

  test('refuses mail addressed to neither the owner nor the alias', () => {
    expect(reason({ recipients: { to: [{ address: 'someone@example.com' }], cc: [] } })).toBe(
      'not_addressed_to_mailbox',
    );
  });

  test('never auto-replies to the owner own address', () => {
    expect(reason({ headers: [{ key: 'From', value: 'Allister <allisteraall@gmail.com>' }] })).toBe(
      'self',
    );
  });
});
