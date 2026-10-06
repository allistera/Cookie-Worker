import { describe, expect, it, vi } from 'vitest';

// Ported from Cookie-Web's api/__tests__/send.test.js — the helper half.
// buildReadReceiptUrl loses its "deployed environment" gate (this Worker only
// exists deployed), and the idempotency key is asynchronous now that it is
// built on Web Crypto.
import {
  appendReadReceipt,
  deliverMail,
  parseFollowUpAt,
  buildReadReceiptUrl,
  claimOutboundEmailQuota,
  immediateSendIdempotencyKey,
  loadProviderAttachments,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  parseAttachmentIds,
  parseRecipients,
  replyThreadingHeaders,
  resolveOwnedAttachments,
  storeSentMessage,
  validateOutboundMessage,
  withAttachmentPayloadSlot,
} from '../src/outbound.js';
import { parseScheduledFor } from '../src/scheduled.js';
import { createMockSql } from './helpers.js';

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

describe('resolveOwnedAttachments', () => {
  const USER_ID = '99999999-9999-4999-8999-999999999999';
  const INBOUND_ID = '11111111-1111-4111-8111-111111111111';
  const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';

  it('resolves a composer upload, not just a forwarded inbound attachment', async () => {
    // Before migration 0060 this query joined `attachments` alone, so a
    // scheduled send carrying a composer upload resolved to nothing and never
    // went out.
    const sql = createMockSql([
      [{ id: UPLOAD_ID, filename: 'plan.pdf', size_bytes: 10, blob_url: 'b', source: 'upload' }],
    ]);

    const result = await resolveOwnedAttachments(sql, USER_ID, [UPLOAD_ID]);

    expect(result.missing).toBeUndefined();
    expect(result.attachments?.[0].source).toBe('upload');
    expect(sql.calls[0].text).toMatch(/outbound_attachments/);
  });

  it('keeps working against a database that has not taken 0060 yet', async () => {
    const undefinedTable = Object.assign(
      new Error('relation "outbound_attachments" does not exist'),
      {
        code: '42P01',
      },
    );
    /** @type {any} */
    let call = 0;
    /** @type {any} */
    const sql = Object.assign(
      (/** @type {any} */ strings, /** @type {any[]} */ ...values) => {
        call += 1;
        sql.calls.push({ text: strings.join('?'), values });
        if (call === 1) return Promise.reject(undefinedTable);
        return Promise.resolve([
          {
            id: INBOUND_ID,
            filename: 'plan.pdf',
            size_bytes: 10,
            blob_url: 'b',
            source: 'inbound',
          },
        ]);
      },
      { calls: /** @type {{text: string, values: unknown[]}[]} */ ([]) },
    );

    const result = await resolveOwnedAttachments(sql, USER_ID, [INBOUND_ID]);

    expect(result.attachments ?? []).toHaveLength(1);
    expect(sql.calls[1].text).not.toMatch(/outbound_attachments/);
  });

  it('rejects the whole send when an id resolves to neither source', async () => {
    const sql = createMockSql([[]]);
    expect((await resolveOwnedAttachments(sql, USER_ID, [UPLOAD_ID])).missing).toBe(true);
  });
});

describe('retry payload stability', () => {
  it('sends byte-identical tracking HTML for the same logical send', async () => {
    const payloads = [];
    const sql = /** @type {any} */ (async () => [{ existing_message_id: 'existing' }]);
    const services = /** @type {any} */ ({
      env: { EMAIL_FROM: 'Cookie <sender@example.com>' },
      createResend: () => ({
        emails: {
          send: async (payload) => {
            payloads.push(payload);
            return { data: { id: 'provider-1' } };
          },
        },
      }),
    });
    const body = {
      recipients: ['recipient@example.com'],
      subject: 'Hi',
      text: 'Body',
      html: '<p>Body</p>',
      replyToMessageId: null,
      idempotencyKey: 'logical-send-1',
    };
    await deliverMail(sql, 'owner', body, services);
    await deliverMail(sql, 'owner', body, services);
    await deliverMail(sql, 'owner', { ...body, idempotencyKey: 'logical-send-2' }, services);
    expect(payloads[0]).toEqual(payloads[1]);
    expect(payloads[2].html).not.toBe(payloads[1].html);
  });
});

it('requires a follow-up after the scheduled send, not just after now', () => {
  const sendAt = Date.now() + 3600000;
  expect(parseFollowUpAt(new Date(sendAt - 1000).toISOString(), sendAt)).toBeNull();
  expect(parseFollowUpAt(new Date(sendAt + 120000).toISOString(), sendAt)).toBeTruthy();
});

describe('reply threading headers', () => {
  const REPLY_TO = '11111111-1111-1111-1111-111111111111';

  it('names the parent and carries the earlier chain', async () => {
    const sql = createMockSql([
      [
        {
          message_id: '<parent@example.com>',
          is_sent: false,
          headers: [
            { key: 'References', value: '<first@example.com> <second@example.com>' },
            { key: 'In-Reply-To', value: '<second@example.com>' },
            { key: 'Subject', value: '<not-a-reference@example.com>' },
          ],
        },
      ],
    ]);

    expect(await replyThreadingHeaders(sql, 'owner', REPLY_TO)).toEqual({
      'In-Reply-To': '<parent@example.com>',
      References: '<first@example.com> <second@example.com> <parent@example.com>',
    });
    expect(sql.calls[0].values).toEqual([REPLY_TO, 'owner']);
  });

  it('leaves out ids the original never really had', async () => {
    for (const row of [
      { message_id: '<synthetic-abc@mail-app-ingest>', is_sent: false, headers: [] },
      { message_id: '<provider-1@resend.cookie-web>', is_sent: true, headers: [] },
      { message_id: 'no-brackets@example.com', is_sent: false, headers: [] },
    ]) {
      expect(await replyThreadingHeaders(createMockSql([[row]]), 'owner', REPLY_TO)).toEqual({});
    }
    expect(await replyThreadingHeaders(createMockSql([[]]), 'owner', REPLY_TO)).toEqual({});
  });

  it('drops the oldest references from an overlong chain but keeps the parent', async () => {
    const chain = Array.from(
      { length: 60 },
      (_, i) => `<message-${i}-${'x'.repeat(40)}@example.com>`,
    );
    const sql = createMockSql([
      [
        {
          message_id: '<parent@example.com>',
          is_sent: false,
          headers: [{ key: 'References', value: chain.join(' ') }],
        },
      ],
    ]);

    const { References } = await replyThreadingHeaders(sql, 'owner', REPLY_TO);

    expect(References.length).toBeLessThanOrEqual(2000);
    expect(References.endsWith(`${chain.at(-1)} <parent@example.com>`)).toBe(true);
    expect(References).not.toContain(chain[0]);
  });

  it('sends a reply with the headers, and without them when the lookup fails', async () => {
    const payloads = [];
    const services = /** @type {any} */ ({
      env: { EMAIL_FROM: 'Cookie <sender@example.com>' },
      createResend: () => ({
        emails: {
          send: async (payload) => {
            payloads.push(payload);
            return { data: { id: 'provider-1' } };
          },
        },
      }),
    });
    const reply = {
      recipients: ['alex@example.com'],
      subject: 'Re: Hi',
      text: 'Thanks',
      html: null,
      replyToMessageId: REPLY_TO,
    };
    const sql = createMockSql([
      [{ message_id: '<parent@example.com>', is_sent: false, headers: [] }],
      [{ existing_message_id: 'stored' }],
    ]);
    await deliverMail(sql, 'owner', reply, services);

    const failing = /** @type {any} */ (
      async (/** @type {TemplateStringsArray} */ strings) => {
        if (strings.join('').includes('m.headers')) throw new Error('database down');
        return [{ existing_message_id: 'stored' }];
      }
    );
    await deliverMail(failing, 'owner', reply, services);

    expect(payloads[0].headers).toEqual({
      'In-Reply-To': '<parent@example.com>',
      References: '<parent@example.com>',
    });
    expect(payloads[1]).not.toHaveProperty('headers');
  });
});

describe('loadProviderAttachments', () => {
  /** @param {number} index */
  const attachment = (index) => ({
    id: `a-${index}`,
    filename: `file-${index}.txt`,
    content_type: 'text/plain',
    blob_url: `https://blob.example/${index}`,
  });

  it('reads a few blobs at a time and keeps the given order', async () => {
    let inFlight = 0;
    let peak = 0;
    const readBlob = async (/** @type {string} */ url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const index = Number(url.split('/').at(-1));
      // Later attachments finish first, so order cannot come from timing.
      await new Promise((resolve) => setTimeout(resolve, (10 - index) * 2));
      inFlight -= 1;
      return { stream: new Response(`body-${index}`).body };
    };
    const attachments = Array.from({ length: 10 }, (_, index) => attachment(index));

    const loaded = await loadProviderAttachments(attachments, readBlob);

    expect(peak).toBe(4);
    expect(loaded.map((item) => item.filename)).toEqual(attachments.map((a) => a.filename));
    expect(atob(loaded[3].content)).toBe('body-3');
  });

  it('enforces the size limit across reads running together', async () => {
    const half = new Uint8Array(Math.floor(MAX_OUTBOUND_ATTACHMENT_BYTES / 2) + 1);
    const readBlob = async () => ({ stream: new Response(half).body });
    await expect(loadProviderAttachments([attachment(1), attachment(2)], readBlob)).rejects.toThrow(
      'Outbound attachments exceed the provider size limit',
    );
  });
});

describe('loadProviderAttachments buffering', () => {
  /** @param {Uint8Array[]} chunks */
  const streamOf = (chunks) =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  const bytes = (/** @type {string} */ text) => new TextEncoder().encode(text);

  it.each([
    ['matches', 11],
    ['overstates', 64],
    ['understates', 4],
    ['is missing', null],
  ])('encodes every byte when the declared size %s the blob', async (_label, size) => {
    const readBlob = async () => ({ stream: streamOf([bytes('hello '), bytes('world')]) });
    const [loaded] = await loadProviderAttachments(
      [{ id: 'a', filename: 'a.txt', size_bytes: size, blob_url: 'https://blob.example/a' }],
      readBlob,
    );
    expect(atob(loaded.content)).toBe('hello world');
  });

  it('still enforces the limit on a blob larger than it declared', async () => {
    const half = new Uint8Array(Math.floor(MAX_OUTBOUND_ATTACHMENT_BYTES / 2) + 1);
    const readBlob = async () => ({ stream: streamOf([half, half]) });
    await expect(
      loadProviderAttachments(
        [{ id: 'a', size_bytes: 1, blob_url: 'https://blob.example/a' }],
        readBlob,
      ),
    ).rejects.toThrow('Outbound attachments exceed the provider size limit');
  });
});

describe('attachment payload slot', () => {
  const env = { RESEND_API_KEY: 'k', EMAIL_FROM: 'Cookie <mail@example.com>' };
  const forward = { id: 'a', filename: 'a.txt', size_bytes: 1, blob_url: 'https://blob.example/a' };

  it('builds and sends one attachment-bearing payload per isolate at a time', async () => {
    /** @type {string[]} */
    const events = [];
    /** @type {Array<() => void>} */
    const accept = [];
    const services = /** @type {any} */ ({
      env,
      createResend: () => ({
        emails: {
          send: (/** @type {any} */ payload) => {
            events.push(`send ${payload.subject}`);
            return new Promise((resolve) => {
              accept.push(() =>
                resolve({ data: { id: `resend-${payload.subject}` }, error: null }),
              );
            });
          },
        },
      }),
      readBlob: async () => {
        events.push('read');
        return { stream: new Response('x').body };
      },
    });
    const message = (/** @type {string} */ subject) => ({
      recipients: ['r@example.com'],
      subject,
      text: 'body',
      html: null,
      replyToMessageId: null,
      readReceiptToken: 'not-a-uuid',
      attachments: [forward],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = createMockSql([]);

    const first = deliverMail(sql, 'user-1', message('one'), services);
    const second = deliverMail(sql, 'user-1', message('two'), services);
    await vi.waitFor(() => expect(accept).toHaveLength(1));
    // The second forward has not even read its blob while the first is out.
    expect(events).toEqual(['read', 'send one']);
    accept[0]();
    await first;
    await vi.waitFor(() => expect(accept).toHaveLength(2));
    expect(events).toEqual(['read', 'send one', 'read', 'send two']);
    accept[1]();
    await second;
  });

  it('lets a waiter through when the holder never releases', async () => {
    vi.useFakeTimers();
    try {
      const wedged = withAttachmentPayloadSlot(() => new Promise(() => {}));
      let ran = false;
      const next = withAttachmentPayloadSlot(async () => {
        ran = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(ran).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(ran).toBe(true);
      void wedged;
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends plain mail without waiting for the slot', async () => {
    const send = vi.fn(async () => ({ data: { id: 'resend-plain' }, error: null }));
    const services = /** @type {any} */ ({ env, createResend: () => ({ emails: { send } }) });
    let release = () => {};
    const holder = withAttachmentPayloadSlot(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await deliverMail(
      createMockSql([]),
      'user-1',
      {
        recipients: ['r@example.com'],
        subject: 's',
        text: 't',
        html: null,
        replyToMessageId: null,
        readReceiptToken: 'not-a-uuid',
      },
      services,
    );
    expect(result.resendId).toBe('resend-plain');
    release();
    await holder;
  });
});

describe('storeSentMessage under a concurrent store of the same provider id', () => {
  const services = /** @type {any} */ ({ env: { EMAIL_FROM: 'Cookie <mail@example.com>' } });
  const message = {
    recipients: ['r@example.com'],
    subject: 'Hello',
    text: 'Body',
    html: null,
    replyToMessageId: null,
    resendId: 'resend-1',
    readReceiptToken: null,
    attachments: [{ filename: 'a.pdf', blob_url: 'https://blob.example/a.pdf' }],
  };

  it('rolls back the thread it opened and returns the winning row', async () => {
    const sql = createMockSql([
      [{ thread_id: null, existing_message_id: null }], // lookup: nothing yet
      [], // insert thread
      [], // insert message: the concurrent store won ON CONFLICT
      [{ id: 'winner-id' }], // re-select the winner
    ]);
    let rolledBack = false;
    sql.begin = vi.fn(async (/** @type {(sql: any) => unknown} */ callback) => {
      try {
        return await callback(sql);
      } catch (err) {
        rolledBack = true;
        throw err;
      }
    });

    const result = await storeSentMessage(sql, 'user-1', message, services);

    expect(result).toEqual({ messageUuid: 'winner-id', inserted: false });
    expect(rolledBack).toBe(true);
    const texts = sql.calls.map((/** @type {{text: string}} */ call) => call.text);
    expect(texts.some((text) => text.includes('INSERT INTO attachments'))).toBe(false);
    const reselect = sql.calls.at(-1);
    expect(reselect.text).toContain('m.message_id = ?');
    expect(reselect.values).toEqual(['user-1', '<resend-1@resend.cookie-web>']);
  });

  it('repairs the follow-up reminder on the winning row', async () => {
    const sql = createMockSql([
      [{ thread_id: 'thread-1', existing_message_id: null }],
      [], // insert message: lost
      [{ id: 'winner-id' }],
      [], // follow-up repair
    ]);

    const result = await storeSentMessage(
      sql,
      'user-1',
      { ...message, followUpAt: '2099-01-01T00:00:00.000Z' },
      services,
    );

    expect(result).toEqual({ messageUuid: 'winner-id', inserted: false });
    const texts = sql.calls.map((/** @type {{text: string}} */ call) => call.text);
    // The thread counter is only bumped for a row this call inserted.
    expect(texts.some((text) => text.includes('UPDATE threads'))).toBe(false);
    expect(sql.calls.at(-1).text).toContain('SET follow_up_at');
    expect(sql.calls.at(-1).values).toContain('winner-id');
  });

  it('still reports a fresh insert as inserted', async () => {
    const sql = createMockSql([
      [{ thread_id: null, existing_message_id: null }],
      [],
      [{ id: 'mine' }],
      [], // attachments
    ]);
    const result = await storeSentMessage(sql, 'user-1', message, services);
    expect(result.inserted).toBe(true);
    expect(result.messageUuid).toBe(sql.calls[2].values[0]);
  });
});
