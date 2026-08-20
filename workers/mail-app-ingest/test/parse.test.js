import { describe, expect, test } from 'vitest';
import {
  canonicalizeMessageId,
  capString,
  htmlToText,
  MAX_FUTURE_MS,
  MAX_HEADER_VALUE,
  MAX_HEADERS,
  MAX_MESSAGE_ID,
  parseEmail,
} from '../src/parse.js';
import { fakeMessage, simpleFixture } from './helpers.js';

describe('canonicalizeMessageId', () => {
  test('wraps bare ids and normalizes existing brackets', () => {
    expect(canonicalizeMessageId('bare-id@example.com')).toBe('<bare-id@example.com>');
    expect(canonicalizeMessageId('<already@example.com>')).toBe('<already@example.com>');
    expect(canonicalizeMessageId('  <spaced@example.com>  ')).toBe('<spaced@example.com>');
  });

  test('returns null for empty or oversized values', () => {
    expect(canonicalizeMessageId('')).toBeNull();
    expect(canonicalizeMessageId('<>')).toBeNull();
    expect(canonicalizeMessageId(`<${'a'.repeat(MAX_MESSAGE_ID)}@example.com>`)).toBeNull();
  });
});

describe('parseEmail', () => {
  test('normalizes a simple fixture', async () => {
    const record = await parseEmail(fakeMessage(simpleFixture));
    expect(record.messageId).toBe('<simple@example.com>');
    expect(record.fromAddress).toBe('alice@example.com');
    expect(record.recipients.to[0].address).toBe('inbox@example.org');
    expect(record.subject).toBe('Hello there');
    expect(record.bodyText).toContain('simple message body');
    expect(record.headers.length).toBeGreaterThan(0);
    expect(record.rawSize).toBeGreaterThan(0);
  });

  test('canonicalizes bare Message-IDs to angle-bracket form', async () => {
    const raw = simpleFixture.replace(
      'Message-ID: <simple@example.com>',
      'Message-ID: bare-id@example.com',
    );
    const record = await parseEmail(fakeMessage(raw));
    expect(record.messageId).toBe('<bare-id@example.com>');
  });

  test('splits and canonicalizes bare References / In-Reply-To headers', async () => {
    const raw = `From: a@example.com
To: b@example.com
Subject: Re: x
Message-ID: <child@example.com>
In-Reply-To: parent@example.com
References: parent@example.com grandparent@example.com
Date: Wed, 08 Jul 2026 12:00:00 +0000
Content-Type: text/plain

Body`;
    const record = await parseEmail(fakeMessage(raw));
    expect(record.references).toEqual(['<parent@example.com>', '<grandparent@example.com>']);
  });

  test('creates deterministic synthetic ids without Message-ID', async () => {
    const raw = simpleFixture.replace('Message-ID: <simple@example.com>\n', '');
    const one = await parseEmail(fakeMessage(raw));
    const two = await parseEmail(fakeMessage(raw));
    expect(one.messageId).toBe(two.messageId);
    expect(one.messageId).toMatch(/^<synthetic-/u);
  });

  test('derives text from html-only mail', async () => {
    const record = await parseEmail(
      fakeMessage(`From: a@example.com
To: b@example.com
Subject: HTML
Message-ID: <html@example.com>
Content-Type: text/html; charset=utf-8

<style>.x{}</style><p>Hello&nbsp;<strong>world</strong></p><script>x()</script>`),
    );
    expect(record.bodyText).toBe('Hello world');
    expect(record.bodyHtml).toContain('<p>');
  });

  test('caps bodies and marks truncated', () => {
    const capped = capString('a'.repeat(600 * 1024), 512 * 1024);
    expect(capped.truncated).toBe(true);
    expect(new TextEncoder().encode(capped.value).byteLength).toBeLessThanOrEqual(512 * 1024);
  });

  test('retains attachment bytes and permits null filenames', async () => {
    const record = await parseEmail(
      fakeMessage(`From: a@example.com
To: b@example.com
Subject: Attachment
Message-ID: <attachment@example.com>
Content-Type: multipart/mixed; boundary="x"

--x
Content-Type: text/plain

Hi
--x
Content-Type: image/png
Content-Disposition: inline
Content-Transfer-Encoding: base64

aGVsbG8=
--x--`),
    );
    expect(record.attachments[0]).toMatchObject({ filename: null, mime_type: 'image/png' });
    expect(record.attachments[0].size).toBeGreaterThan(0);
    expect(new TextDecoder().decode(record.attachments[0].content)).toBe('hello');
  });

  test('strips NUL values', async () => {
    const record = await parseEmail(
      fakeMessage(simpleFixture.replace('Hello there', 'Hello\0there')),
    );
    expect(record.subject).toBe('Hellothere');
  });

  test('replaces oversized Message-ID with synthetic id', async () => {
    const raw = simpleFixture.replace(
      '<simple@example.com>',
      `<${'a'.repeat(MAX_MESSAGE_ID)}@example.com>`,
    );
    const record = await parseEmail(fakeMessage(raw));
    expect(record.messageId).toMatch(/^<synthetic-/u);
  });

  test('falls back to envelope sender when From cannot be parsed', async () => {
    const record = await parseEmail(
      fakeMessage(simpleFixture.replace('From: Alice <alice@example.com>', 'From: ???'), {
        from: 'bounce@example.com',
      }),
    );
    expect(record.fromAddress).toBe('bounce@example.com');
  });

  test('htmlToText handles common entities and block spacing', () => {
    expect(htmlToText('<div>A&amp;B<br>C &lt; D &quot;x&quot;</div>')).toBe('A&B\nC < D "x"');
  });

  test('clamps far-future Date headers to now', async () => {
    const farFuture = new Date(Date.now() + MAX_FUTURE_MS + 60_000).toUTCString();
    const raw = simpleFixture.replace(
      'Date: Wed, 08 Jul 2026 12:00:00 +0000',
      `Date: ${farFuture}`,
    );
    const before = Date.now();
    const record = await parseEmail(fakeMessage(raw));
    const after = Date.now();
    expect(record.sentAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(record.sentAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  test('caps headers at MAX_HEADERS and bounds values', async () => {
    const extra = Array.from(
      { length: MAX_HEADERS + 20 },
      (_, i) => `X-Extra-${i}: ${'v'.repeat(MAX_HEADER_VALUE + 50)}`,
    ).join('\n');
    const raw = simpleFixture.replace(
      'Content-Type: text/plain; charset=utf-8',
      `${extra}\nContent-Type: text/plain; charset=utf-8`,
    );
    const record = await parseEmail(fakeMessage(raw));
    expect(record.headers.length).toBeLessThanOrEqual(MAX_HEADERS);
    expect(record.headers.every((header) => header.value.length <= MAX_HEADER_VALUE)).toBe(true);
  });
});
