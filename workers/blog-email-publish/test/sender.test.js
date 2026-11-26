import { describe, expect, test } from 'vitest';
import { automaticMailReason, checkSender, dmarcPassedFor } from '../src/sender.js';

const ALLOWED = 'me@example.com';
// The shape Cloudflare Email Routing writes, tabs included.
const PASS =
  'mx.cloudflare.net;\tdkim=pass header.d=example.com header.s=resend header.b=abc;\tdmarc=pass header.from=example.com policy.dmarc=reject;\tspf=pass (mx.cloudflare.net: domain of bounce@send.example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@send.example.com';

/** @param {[string, string][]} headers */
function email(headers, address = ALLOWED) {
  return { from: { address }, headers: headers.map(([key, value]) => ({ key, value })) };
}

describe('dmarcPassedFor', () => {
  test("accepts Cloudflare's pass for the claimed domain", () => {
    expect(dmarcPassedFor([{ key: 'authentication-results', value: PASS }], 'example.com')).toBe(
      true,
    );
  });

  test('refuses a pass recorded for another domain', () => {
    expect(dmarcPassedFor([{ key: 'authentication-results', value: PASS }], 'example.org')).toBe(
      false,
    );
  });

  test.each([
    ['a failed check', 'mx.cloudflare.net; dmarc=fail header.from=example.com'],
    ['no DMARC result', 'mx.cloudflare.net; spf=pass smtp.mailfrom=me@example.com'],
    ['another server', 'mx.attacker.test; dmarc=pass header.from=example.com'],
    ['a look-alike method', 'mx.cloudflare.net; x-dmarc=pass header.from=example.com'],
  ])('refuses %s', (_name, value) => {
    expect(dmarcPassedFor([{ key: 'authentication-results', value }], 'example.com')).toBe(false);
  });

  test('refuses a message with no verdict at all', () => {
    expect(dmarcPassedFor([{ key: 'from', value: ALLOWED }], 'example.com')).toBe(false);
  });

  test('reads only the first verdict, the one Cloudflare prepends', () => {
    const forged = 'mx.cloudflare.net; dmarc=pass header.from=example.com';
    const headers = [
      {
        key: 'authentication-results',
        value: 'mx.cloudflare.net; dmarc=fail header.from=example.com',
      },
      { key: 'authentication-results', value: forged },
    ];

    expect(dmarcPassedFor(headers, 'example.com')).toBe(false);
  });
});

describe('checkSender', () => {
  test('authorises the allowed sender when DMARC passed', () => {
    const message = email(
      [
        ['authentication-results', PASS],
        ['from', 'Me <ME@Example.com>'],
      ],
      'ME@Example.com',
    );

    expect(checkSender(message, ' Me@example.com ')).toBe('authorised');
  });

  test('turns away anyone else, authenticated or not', () => {
    const message = email(
      [
        ['authentication-results', 'mx.cloudflare.net; dmarc=pass header.from=example.org'],
        ['from', 'someone@example.org'],
      ],
      'someone@example.org',
    );

    expect(checkSender(message, ALLOWED)).toBe('sender_not_allowed');
  });

  test('does not trust the From header without a DMARC pass', () => {
    const message = email([
      ['authentication-results', 'mx.cloudflare.net; dmarc=none header.from=example.com'],
      ['from', ALLOWED],
    ]);

    expect(checkSender(message, ALLOWED)).toBe('unauthenticated');
  });

  test('turns away a message with two From headers', () => {
    const message = email([
      ['authentication-results', PASS],
      ['from', ALLOWED],
      ['from', 'someone@example.org'],
    ]);

    expect(checkSender(message, ALLOWED)).toBe('sender_not_allowed');
  });

  test('turns away everything while no sender is configured', () => {
    const message = email([['authentication-results', PASS]], '');

    expect(checkSender(message, '')).toBe('sender_not_allowed');
  });
});

describe('automaticMailReason', () => {
  test('passes mail a person wrote, including Auto-Submitted: no', () => {
    expect(automaticMailReason(email([['from', ALLOWED]]))).toBeNull();
    expect(automaticMailReason(email([['auto-submitted', ' No ']]))).toBeNull();
  });

  test.each(['auto-replied', 'auto-generated', 'auto-notified; owner-email="me@example.com"'])(
    'marks Auto-Submitted: %s',
    (value) => {
      expect(automaticMailReason(email([['auto-submitted', value]]))).toBe('auto_submitted');
    },
  );

  test('marks a message with a calendar part', () => {
    const message = { ...email([['from', ALLOWED]]), attachments: [{ mimeType: 'Text/Calendar' }] };

    expect(automaticMailReason(message)).toBe('calendar');
  });

  test('passes other attachments', () => {
    const message = { ...email([['from', ALLOWED]]), attachments: [{ mimeType: 'image/png' }] };

    expect(automaticMailReason(message)).toBeNull();
  });
});
