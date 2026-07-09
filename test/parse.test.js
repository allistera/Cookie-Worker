import { describe, expect, test } from 'vitest';
import { capString, htmlToText, MAX_MESSAGE_ID, parseEmail } from '../src/parse.js';
import { fakeMessage, simpleFixture } from './helpers.js';

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

  test('creates deterministic synthetic ids without Message-ID', async () => {
    const raw = simpleFixture.replace('Message-ID: <simple@example.com>\n', '');
    const one = await parseEmail(fakeMessage(raw));
    const two = await parseEmail(fakeMessage(raw));
    expect(one.messageId).toBe(two.messageId);
    expect(one.messageId).toMatch(/^<synthetic-/u);
  });

  test('derives text from html-only mail', async () => {
    const record = await parseEmail(fakeMessage(`From: a@example.com
To: b@example.com
Subject: HTML
Message-ID: <html@example.com>
Content-Type: text/html; charset=utf-8

<style>.x{}</style><p>Hello&nbsp;<strong>world</strong></p><script>x()</script>`));
    expect(record.bodyText).toBe('Hello world');
    expect(record.bodyHtml).toContain('<p>');
  });

  test('caps bodies and marks truncated', () => {
    const capped = capString('a'.repeat(600 * 1024), 512 * 1024);
    expect(capped.truncated).toBe(true);
    expect(new TextEncoder().encode(capped.value).byteLength).toBeLessThanOrEqual(512 * 1024);
  });

  test('records attachment metadata only and permits null filenames', async () => {
    const record = await parseEmail(fakeMessage(`From: a@example.com
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
--x--`));
    expect(record.attachments[0]).toMatchObject({ filename: null, mime_type: 'image/png' });
    expect(record.attachments[0].size).toBeGreaterThan(0);
  });

  test('strips NUL values', async () => {
    const record = await parseEmail(fakeMessage(simpleFixture.replace('Hello there', 'Hello\0there')));
    expect(record.subject).toBe('Hellothere');
  });

  test('replaces oversized Message-ID with synthetic id', async () => {
    const raw = simpleFixture.replace('<simple@example.com>', `<${'a'.repeat(MAX_MESSAGE_ID)}@example.com>`);
    const record = await parseEmail(fakeMessage(raw));
    expect(record.messageId).toMatch(/^<synthetic-/u);
  });

  test('falls back to envelope sender when From cannot be parsed', async () => {
    const record = await parseEmail(fakeMessage(simpleFixture.replace('From: Alice <alice@example.com>', 'From: ???'), {
      from: 'bounce@example.com',
    }));
    expect(record.fromAddress).toBe('bounce@example.com');
  });

  test('htmlToText handles common entities and block spacing', () => {
    expect(htmlToText('<div>A&amp;B<br>C &lt; D &quot;x&quot;</div>')).toBe('A&B\nC < D "x"');
  });
});
