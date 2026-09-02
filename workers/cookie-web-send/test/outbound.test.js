import { describe, expect, it } from 'vitest';

// Ported from Cookie-Web's api/__tests__/send.test.js — the helper half.
// buildReadReceiptUrl loses its "deployed environment" gate (this Worker only
// exists deployed), and the idempotency key is asynchronous now that it is
// built on Web Crypto.
import {
  appendReadReceipt,
  buildReadReceiptUrl,
  claimOutboundEmailQuota,
  immediateSendIdempotencyKey,
  parseAttachmentIds,
  parseRecipients,
  validateOutboundMessage,
} from '../src/outbound.js';
import { parseScheduledFor } from '../src/scheduled.js';

describe('parseRecipients', () => {
  it('parses a comma-separated to field into trimmed addresses', () => {
    expect(parseRecipients('a@b.com, c@d.com')).toEqual(['a@b.com', 'c@d.com']);
    expect(parseRecipients(' a@b.com ')).toEqual(['a@b.com']);
    expect(parseRecipients('a@b.com,,c@d.com,')).toEqual(['a@b.com', 'c@d.com']);
  });

  it('returns an empty list for non-strings or blank input', () => {
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients(null)).toEqual([]);
    expect(parseRecipients(42)).toEqual([]);
    expect(parseRecipients('')).toEqual([]);
  });

  it('rejects recipient fan-out above the application limit', () => {
    const many = Array.from({ length: 21 }, (_, i) => `person${i}@example.com`).join(', ');
    expect(parseRecipients(many)).toEqual([]);
    // A multi-megabyte comma flood is rejected before split() expands it.
    expect(parseRecipients(','.repeat(20_000))).toEqual([]);
  });
});

describe('parseAttachmentIds', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';

  it('accepts a bounded unique UUID list and treats omission as no attachments', () => {
    expect(parseAttachmentIds(undefined)).toEqual([]);
    expect(parseAttachmentIds([first, second])).toEqual([first, second]);
  });

  it('rejects malformed, duplicate, and oversized attachment id lists', () => {
    expect(parseAttachmentIds('not-an-array')).toBeNull();
    expect(parseAttachmentIds(['not-a-uuid'])).toBeNull();
    expect(parseAttachmentIds([first, first])).toBeNull();
    expect(
      parseAttachmentIds(
        Array.from(
          { length: 21 },
          (_, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        ),
      ),
    ).toBeNull();
  });
});

describe('outbound email abuse bounds', () => {
  const base = { to: 'a@b.com', subject: 'Hi', text: 'Body', html: null };

  it('accepts a normal bounded message', () => {
    const result = validateOutboundMessage(base);
    expect(result.recipients).toEqual(['a@b.com']);
    expect(result.error).toBeUndefined();
  });

  it('rejects oversized subject, text, HTML, and aggregate content', () => {
    expect(validateOutboundMessage({ ...base, subject: 'x'.repeat(999) }).error).toBeTruthy();
    expect(validateOutboundMessage({ ...base, text: 'x'.repeat(100_001) }).error).toBeTruthy();
    expect(validateOutboundMessage({ ...base, html: 'x'.repeat(200_001) }).error).toBeTruthy();
    expect(
      validateOutboundMessage({
        ...base,
        text: 'x'.repeat(90_000),
        html: 'y'.repeat(170_000),
      }).error,
    ).toBeTruthy();
  });

  it('rejects header-injection shapes in recipients and subject', () => {
    expect(validateOutboundMessage({ ...base, to: 'a@b.com\r\nBcc: e@f.com' }).error).toBeTruthy();
    expect(validateOutboundMessage({ ...base, subject: 'Hi\r\nBcc: e@f.com' }).error).toBeTruthy();
  });

  it('uses one atomic server-side quota claim scoped to a provisioned user', async () => {
    let query = '';
    /** @type {unknown[]} */
    let values = [];
    /** @type {any} */
    const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...vals) => {
      query = strings.join('?');
      values = vals;
      return Promise.resolve([{ authorized: true, quota_claimed: true }]);
    };

    const result = await claimOutboundEmailQuota(sql, 'user-1');

    expect(result).toEqual({ authorized: true, quota_claimed: true });
    expect(query).toContain('INSERT INTO outbound_email_quotas');
    expect(query).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(query).toContain('EXISTS (SELECT 1 FROM users WHERE id = ?)');
    expect(values).toContain('user-1');
  });
});

describe('read receipt helpers', () => {
  const token = '11111111-1111-4111-8111-111111111111';

  it('builds an opaque-token Worker URL and rejects non-UUID tokens', () => {
    expect(buildReadReceiptUrl(token)).toBe(
      `https://receipts-api.infinitywave.online/read-receipts?token=${token}`,
    );
    expect(buildReadReceiptUrl('not-a-token')).toBeNull();
  });

  it('adds the pixel to sent HTML and safely creates HTML for plain text', () => {
    const url = `https://receipts-api.infinitywave.online/read-receipts?token=${token}`;
    expect(appendReadReceipt('<p>Hello</p>', 'Hello', url)).toContain(
      `<p>Hello</p><img src="${url}"`,
    );
    const fromText = appendReadReceipt(null, '<Hello>\nWorld', url);
    expect(fromText).toContain('&lt;Hello&gt;<br>World');
    expect(fromText).not.toContain('<Hello>');
  });
});

describe('parseScheduledFor', () => {
  it('accepts an ISO timestamp comfortably in the future', () => {
    const iso = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(parseScheduledFor(iso)).toBe(new Date(iso).toISOString());
  });

  it('rejects missing, unparsable, past, or too-soon values', () => {
    expect(parseScheduledFor(undefined)).toBeNull();
    expect(parseScheduledFor('not a date')).toBeNull();
    expect(parseScheduledFor(new Date(Date.now() - 60_000).toISOString())).toBeNull();
    expect(parseScheduledFor(new Date(Date.now() + 10_000).toISOString())).toBeNull();
  });
});

describe('immediateSendIdempotencyKey', () => {
  const message = {
    recipients: ['a@b.com'],
    subject: 'Hi',
    text: 'Body',
    html: null,
    replyToMessageId: null,
    requestId: null,
  };

  it('is deterministic for identical content and user', async () => {
    const first = await immediateSendIdempotencyKey('user-1', message);
    const second = await immediateSendIdempotencyKey('user-1', message);
    expect(first).toBe(second);
    expect(first).toMatch(/^immediate-send\/[0-9a-f]{64}$/);
  });

  it('changes when the requestId changes, letting deliberate duplicates through', async () => {
    const first = await immediateSendIdempotencyKey('user-1', message);
    const second = await immediateSendIdempotencyKey('user-1', {
      ...message,
      requestId: 'retry-2',
    });
    expect(first).not.toBe(second);
  });
});
