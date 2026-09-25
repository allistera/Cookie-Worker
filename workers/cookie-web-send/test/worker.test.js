import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Ported from Cookie-Web's api/__tests__/send-handler.test.js and
// send-scheduled.test.js — the same scripted query sequences and
// expectations, driven through the Worker fetch handler. Each entry in
// `responses` is the return value of the Nth sql`...` invocation, in call
// order; sql.begin runs its callback against the same counter so statements
// executed inside a transaction consume responses too.
/** @type {any[]} */
let responses = [];
let call = 0;
const scriptedQuery = async (/** @type {any[]} */ ..._args) => {
  const response = responses[call++] ?? [];
  if (response instanceof Error) throw response;
  return response;
};
const mockQuery = vi.fn(scriptedQuery);
const sqlEnd = vi.fn(async () => undefined);
// Every client this suite hands out, in creation order: the search sync has to
// run on its own connection, not the request-scoped one fetch closes.
/** @type {any[]} */
let clients = [];
vi.mock('postgres', () => ({
  default: () => {
    /** @type {any} */
    const sql = (/** @type {any[]} */ ...args) => mockQuery(...args);
    sql.begin = async (/** @type {(sql: any) => unknown} */ callback) => callback(sql);
    sql.end = sqlEnd;
    clients.push(sql);
    return sql;
  },
}));

const syncMessageToMeili = vi.fn(
  async (/** @type {any} */ _sql, /** @type {any} */ _env, /** @type {string} */ _uuid) =>
    undefined,
);
const syncMessagesToMeili = vi.fn(
  async (/** @type {any} */ _sql, /** @type {any} */ _env, /** @type {string[]} */ _uuids) =>
    undefined,
);
vi.mock('../../../shared/meiliSync.js', () => ({
  syncMessageToMeili: (/** @type {any} */ sql, /** @type {any} */ env, /** @type {any} */ uuid) =>
    syncMessageToMeili(sql, env, uuid),
  syncMessagesToMeili: (/** @type {any} */ sql, /** @type {any} */ env, /** @type {any} */ uuids) =>
    syncMessagesToMeili(sql, env, uuids),
}));

const resendSend = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (/** @type {any[]} */ ...args) => resendSend(...args) };
  },
}));

const getBlob = vi.fn();
vi.mock('@vercel/blob', () => ({
  get: (...args) => getBlob(...args),
}));

const verifyAccessToken = vi.fn();
vi.mock('../../../shared/auth-jwt.js', () => ({
  verifyAccessToken: (...args) => verifyAccessToken(...args),
  authFailureResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

const captureHandledException = vi.fn();
vi.mock('../src/sentry.js', () => ({
  createSentryOptions: () => ({ enabled: false }),
  captureHandledException: (...args) => captureHandledException(...args),
}));

const worker = (await import('../src/worker.js')).default;
const { MAX_OUTBOUND_ATTACHMENT_BYTES } = await import('../src/outbound.js');

const PRODUCTION = 'https://mail.infinitywave.online';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const env = /** @type {any} */ ({
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  AUTH0_DOMAIN: 'tenant.example.auth0.com',
  AUTH0_AUDIENCE: 'https://cookie-web/api',
  ALLOWED_ORIGIN: PRODUCTION,
  RESEND_API_KEY: 'test-key',
  EMAIL_FROM: 'Cookie <mail@example.com>',
  SCHEDULED_SEND_FLUSH_TOKEN: 'flush-secret',
  BLOB_READ_WRITE_TOKEN: 'blob-token',
});
// The Durable Object binding, for the tests that queue a send. Kept off the
// shared env because one test compares env by value and functions break that.
const clockArm = vi.fn(
  async (/** @type {Request} */ _request) => new Response(null, { status: 204 }),
);
const clockEnv = /** @type {any} */ ({
  ...env,
  SCHEDULED_SEND_CLOCK: {
    idFromName: () => 'clock-id',
    get: () => ({
      fetch: (/** @type {string} */ input, /** @type {RequestInit} */ init) =>
        clockArm(new Request(input, init)),
    }),
  },
});
/** @type {Promise<unknown>[]} */
let waited = [];
const ctx = /** @type {any} */ ({
  waitUntil: (/** @type {Promise<unknown>} */ promise) => waited.push(promise),
});

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-send.example${path}`, {
    method: 'POST',
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

/** @param {Record<string, unknown>} [overrides] */
function sendBody(overrides = {}) {
  return JSON.stringify({
    to: 'recipient@example.com',
    subject: 'Hello',
    text: 'Plain text',
    ...overrides,
  });
}

const futureIso = (msFromNow = 10 * 60_000) => new Date(Date.now() + msFromNow).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockImplementation(scriptedQuery);
  responses = [];
  call = 0;
  waited = [];
  clients = [];
  verifyAccessToken.mockResolvedValue({ userId: USER_ID });
});

afterEach(async () => {
  await Promise.all(waited);
  vi.useRealTimers();
});

describe('POST /send security boundaries', () => {
  test('answers 503 when Resend or EMAIL_FROM is unconfigured', async () => {
    const response = await worker.fetch(
      request('/send', { body: sendBody() }),
      { ...env, RESEND_API_KEY: undefined },
      ctx,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Email sending is not configured' });
  });

  test('stops oversized content before touching the database or provider', async () => {
    const response = await worker.fetch(
      request('/send', { body: sendBody({ text: 'x'.repeat(100_001) }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });

  test('stops a quota-exhausted request before constructing a provider send', async () => {
    responses = [[{ authorized: true, quota_claimed: false }]];
    const response = await worker.fetch(request('/send', { body: sendBody() }), env, ctx);
    expect(response.status).toBe(429);
    expect(resendSend).not.toHaveBeenCalled();
  });

  test('403s an unprovisioned subject before constructing a provider send', async () => {
    responses = [[{ authorized: false, quota_claimed: false }]];
    const response = await worker.fetch(request('/send', { body: sendBody() }), env, ctx);
    expect(response.status).toBe(403);
    expect(resendSend).not.toHaveBeenCalled();
  });

  test('delivers a provisioned send, stores the copy, and returns the provider id', async () => {
    responses = [
      [{ authorized: true, quota_claimed: true }], // quota claim
      [{ user_id: USER_ID, thread_id: null }], // storeSentMessage lookup
      [], // insert threads (sql.begin)
      [{ id: 'stored' }], // insert messages (sql.begin), RETURNING id
      [], // read receipt insert
    ];
    resendSend.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
    const response = await worker.fetch(request('/send', { body: sendBody() }), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'resend-1', messageId: expect.any(String) });
    const [payload, options] = resendSend.mock.calls[0];
    expect(payload.to).toEqual(['recipient@example.com']);
    expect(payload.from).toBe('Cookie <mail@example.com>');
    // Every send carries the read-receipt pixel now — there is no
    // undeployed-environment gate on a Worker.
    expect(payload.html).toContain('receipts-api.infinitywave.online/read-receipts?token=');
    expect(options.idempotencyKey).toMatch(/^immediate-send\/[0-9a-f]{64}$/);
  });

  test('delivers an owned private attachment and stores it on the sent copy', async () => {
    const attachmentId = '22222222-2222-4222-8222-222222222222';
    const attachment = {
      id: attachmentId,
      filename: 'plan.pdf',
      content_type: 'application/pdf',
      size_bytes: 3,
      blob_url: 'https://store.private.blob.vercel-storage.com/plan.pdf',
    };
    responses = [
      [attachment],
      [{ authorized: true, quota_claimed: true }],
      [{ user_id: USER_ID, thread_id: null }],
      [],
      [{ id: 'stored' }],
      [],
      [],
    ];
    getBlob.mockResolvedValue({
      statusCode: 200,
      stream: new Response('pdf').body,
      blob: { size: 3 },
    });
    resendSend.mockResolvedValue({ data: { id: 'resend-forward' }, error: null });

    const response = await worker.fetch(
      request('/send', { body: sendBody({ attachmentIds: [attachmentId] }) }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(getBlob).toHaveBeenCalledWith(attachment.blob_url, {
      access: 'private',
      token: 'blob-token',
    });
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: 'plan.pdf',
            contentType: 'application/pdf',
            content: 'cGRm',
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(
      mockQuery.mock.calls.some(([parts]) => parts.join(' ').includes('INSERT INTO attachments')),
    ).toBe(true);
  });

  test('rejects malformed and unowned attachment ids before provider delivery', async () => {
    const malformed = await worker.fetch(
      request('/send', { body: sendBody({ attachmentIds: ['not-a-uuid'] }) }),
      env,
      ctx,
    );
    expect(malformed.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();

    responses = [[]];
    const unowned = await worker.fetch(
      request('/send', {
        body: sendBody({
          attachmentIds: ['22222222-2222-4222-8222-222222222222'],
        }),
      }),
      env,
      ctx,
    );
    expect(unowned.status).toBe(404);
    expect(getBlob).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });

  test('rejects raw attachments that would exceed the provider limit after encoding', async () => {
    const attachmentId = '22222222-2222-4222-8222-222222222222';
    responses = [
      [
        {
          id: attachmentId,
          filename: 'too-large.zip',
          content_type: 'application/zip',
          size_bytes: MAX_OUTBOUND_ATTACHMENT_BYTES + 1,
          blob_url: 'https://store.private.blob.vercel-storage.com/too-large.zip',
        },
      ],
    ];

    const response = await worker.fetch(
      request('/send', { body: sendBody({ attachmentIds: [attachmentId] }) }),
      env,
      ctx,
    );

    expect(response.status).toBe(400);
    expect(getBlob).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });

  test('refunds the quota and answers 502 when the provider fails', async () => {
    responses = [
      [{ authorized: true, quota_claimed: true }], // quota claim
      [], // refund update
    ];
    resendSend.mockResolvedValue({ data: null, error: { message: 'bounced' } });
    const response = await worker.fetch(request('/send', { body: sendBody() }), env, ctx);

    expect(response.status).toBe(502);
    const queries = mockQuery.mock.calls.map(([parts]) => parts.join(' '));
    expect(queries.some((query) => query.includes('GREATEST(send_count - 1, 0)'))).toBe(true);
  });
});

describe('POST /send with sendAt (schedule creation)', () => {
  test('queues a scheduled_sends row instead of calling the provider', async () => {
    responses = [
      [], // advisory lock (sql.begin)
      [
        {
          id: 'sched-1',
          toAddresses: 'recipient@example.com',
          subject: 'Hello',
          scheduledFor: futureIso(),
        },
      ],
    ];
    const response = await worker.fetch(
      request('/send', { body: sendBody({ sendAt: futureIso() }) }),
      env,
      ctx,
    );

    expect(response.status).toBe(201);
    expect((await response.json()).scheduledSend.id).toBe('sched-1');
    expect(resendSend).not.toHaveBeenCalled();
  });

  // The Durable Object alarm is what delivers on time; the cron is only the
  // safety net. Arming rides in waitUntil so the response is not held up.
  test('arms the scheduled-send clock for the new row after responding', async () => {
    const sendAt = futureIso();
    responses = [[], [{ id: 'sched-2', scheduledFor: sendAt }]];
    clockArm.mockClear();

    const response = await worker.fetch(
      request('/send', { body: sendBody({ sendAt }) }),
      clockEnv,
      ctx,
    );
    expect(response.status).toBe(201);
    await Promise.all(waited);

    expect(clockArm).toHaveBeenCalledTimes(1);
    const armRequest = /** @type {Request} */ (clockArm.mock.calls[0]?.[0]);
    expect(new URL(armRequest.url).pathname).toBe('/arm');
    expect(Date.parse((await armRequest.json()).at)).toBe(Date.parse(sendAt));
  });

  test('a failed arm is logged and never fails the schedule request', async () => {
    responses = [[], [{ id: 'sched-3', scheduledFor: futureIso() }]];
    clockArm.mockRejectedValueOnce(new Error('clock unavailable'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await worker.fetch(
      request('/send', { body: sendBody({ sendAt: futureIso() }) }),
      clockEnv,
      ctx,
    );
    expect(response.status).toBe(201);
    await expect(Promise.all(waited)).resolves.toBeDefined();

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'scheduled_send_arm_failed', error: 'clock unavailable' }),
    );
    log.mockRestore();
  });

  test('rejects a sendAt less than a minute out without touching the database', async () => {
    const response = await worker.fetch(
      request('/send', { body: sendBody({ sendAt: futureIso(1000) }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('reports 429 when the per-user pending cap is hit', async () => {
    responses = [
      [], // advisory lock (sql.begin)
      [], // insert suppressed by the cap
    ];
    const response = await worker.fetch(
      request('/send', { body: sendBody({ sendAt: futureIso() }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(429);
  });

  test('stores attachment references beside a scheduled send', async () => {
    const attachmentId = '22222222-2222-4222-8222-222222222222';
    responses = [
      [
        {
          id: attachmentId,
          filename: 'plan.pdf',
          content_type: 'application/pdf',
          size_bytes: 3,
          blob_url: 'https://store.private.blob.vercel-storage.com/plan.pdf',
        },
      ],
      [],
      [{ id: 'sched-1', scheduledFor: futureIso() }],
      [],
    ];

    const response = await worker.fetch(
      request('/send', {
        body: sendBody({ sendAt: futureIso(), attachmentIds: [attachmentId] }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(201);
    expect(
      mockQuery.mock.calls.some(([parts]) =>
        parts.join(' ').includes('INSERT INTO scheduled_send_attachments'),
      ),
    ).toBe(true);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

describe('GET/DELETE /send/scheduled', () => {
  test("lists the authenticated user's pending and failed scheduled sends", async () => {
    const rows = [
      {
        id: 'sched-1',
        toAddresses: 'a@b.com',
        subject: 'Hi',
        scheduledFor: futureIso(),
        status: 'pending',
        lastError: null,
      },
    ];
    responses = [rows];
    const response = await worker.fetch(request('/send/scheduled', { method: 'GET' }), env, ctx);

    expect(response.status).toBe(200);
    expect((await response.json()).scheduledSends).toEqual(rows);
  });

  test('retries the list once on a fresh connection when the socket drops', async () => {
    const rows = [{ id: 'sched-1', status: 'pending' }];
    responses = [new Error('Network connection lost.'), rows];
    const response = await worker.fetch(request('/send/scheduled', { method: 'GET' }), env, ctx);

    expect(response.status).toBe(200);
    expect((await response.json()).scheduledSends).toEqual(rows);
    expect(captureHandledException).not.toHaveBeenCalled();
  });

  test('does not retry a cancel when the socket drops', async () => {
    responses = [new Error('Network connection lost.')];
    const response = await worker.fetch(
      request('/send/scheduled', { method: 'DELETE', body: JSON.stringify({ id: USER_ID }) }),
      env,
      ctx,
    );

    expect(response.status).toBe(500);
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  test('cancels a pending scheduled send and returns its content for the composer', async () => {
    const row = {
      id: 'sched-1',
      toAddresses: 'a@b.com',
      subject: 'Hi',
      text: 'Body',
      html: null,
      replyToMessageId: null,
      attachments: [{ id: 'att-1', filename: 'plan.pdf', downloadable: true }],
    };
    responses = [[row], []];
    const response = await worker.fetch(
      request('/send/scheduled', { method: 'DELETE', body: JSON.stringify({ id: USER_ID }) }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).scheduledSend).toEqual(row);
    expect(mockQuery.mock.calls[0][0].join(' ')).toContain('scheduled_send_attachments');
  });

  test('keeps attachment-free cancellation working before migration 0059 is applied', async () => {
    const missingTable = Object.assign(
      new Error('relation "scheduled_send_attachments" does not exist'),
      { code: '42P01' },
    );
    const row = {
      id: 'sched-1',
      toAddresses: 'a@b.com',
      subject: 'Hi',
      text: 'Body',
      html: null,
      replyToMessageId: null,
      attachments: [],
    };
    responses = [missingTable, [row], []];
    const response = await worker.fetch(
      request('/send/scheduled', { method: 'DELETE', body: JSON.stringify({ id: USER_ID }) }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).scheduledSend).toEqual(row);
    expect(mockQuery.mock.calls[1][0].join(' ')).toContain("'[]'::jsonb AS attachments");
  });

  test('404s canceling an id that is no longer pending', async () => {
    responses = [[]];
    const response = await worker.fetch(
      request('/send/scheduled', { method: 'DELETE', body: JSON.stringify({ id: USER_ID }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /send/flush', () => {
  /** @param {Record<string, string>} [headers] */
  function flushRequest(headers = {}) {
    return new Request('https://cookie-web-send.example/send/flush', {
      method: 'POST',
      headers,
    });
  }

  test('rejects a missing or wrong bearer token without touching the database', async () => {
    const first = await worker.fetch(flushRequest(), env, ctx);
    expect(first.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(verifyAccessToken).not.toHaveBeenCalled();

    const second = await worker.fetch(flushRequest({ Authorization: 'Bearer wrong' }), env, ctx);
    expect(second.status).toBe(401);
  });

  test('returns the scheduled result while automatic work owns a separate live connection', async () => {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    mockQuery.mockImplementation(async (parts) => {
      if (parts.join(' ').includes('FROM messages m JOIN users u')) return pending;
      return [];
    });
    try {
      const response = await worker.fetch(
        flushRequest({ Authorization: 'Bearer flush-secret' }),
        env,
        ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        claimed: 0,
        sent: 0,
        retried: 0,
        failed: 0,
        unconfirmed: 0,
      });
      expect(clients).toHaveLength(2);
      expect(sqlEnd).toHaveBeenCalledTimes(1);
      expect(sqlEnd.mock.contexts[0]).toBe(clients[0]);
    } finally {
      release([]);
    }
    await Promise.all(waited);
    expect(sqlEnd).toHaveBeenCalledTimes(2);
    expect(sqlEnd.mock.contexts[1]).toBe(clients[1]);
  });

  test('delivers a claimed due row end to end and marks it sent', async () => {
    const claimedRow = {
      id: 'sched-1',
      user_id: 'user-1',
      toAddresses: 'recipient@example.com',
      subject: 'Hello',
      text: 'Plain text',
      html: null,
      replyToMessageId: null,
      attempts: 0,
      followUpAt: futureIso(3600000),
    };
    responses = [
      [claimedRow], // claimDueScheduledSends
      [{ email: 'owner@example.com' }], // owner lookup
      [{ authorized: true, quota_claimed: true }], // claimOutboundEmailQuota
      [{ user_id: 'user-1', thread_id: null }], // storeSentMessage lookup
      [], // insert threads (sql.begin)
      [{ id: 'stored' }], // insert messages (sql.begin), RETURNING id
      // no receipt row: 'sched-1' is not a UUID, so no pixel token is stored
      [], // mark 'sent'
    ];
    resendSend.mockResolvedValue({ data: { id: 'resend-9' }, error: null });
    const response = await worker.fetch(
      flushRequest({ Authorization: 'Bearer flush-secret' }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      unconfirmed: 0,
    });
    const messageWrite = mockQuery.mock.calls.find(([strings]) =>
      strings.join('').includes('INSERT INTO messages'),
    );
    if (!messageWrite) throw new Error('Expected sent-copy insert');
    expect(messageWrite[0].join('')).toContain('follow_up_at');
    expect(messageWrite.slice(1)).toContain(claimedRow.followUpAt);
    expect(mockQuery.mock.calls[0][0].join('')).toContain('s.follow_up_at AS "followUpAt"');
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['recipient@example.com'] }),
      {
        idempotencyKey: 'scheduled-send/sched-1',
      },
    );
  });

  test('flushes scheduled attachments through Resend and into the sent copy', async () => {
    const attachment = {
      id: '22222222-2222-4222-8222-222222222222',
      filename: 'plan.pdf',
      content_type: 'application/pdf',
      size_bytes: 3,
      blob_url: 'https://store.private.blob.vercel-storage.com/plan.pdf',
    };
    responses = [
      [
        {
          id: 'sched-forward',
          user_id: 'user-1',
          toAddresses: 'recipient@example.com',
          subject: 'Fwd: Plan',
          text: 'Forwarded plan',
          html: null,
          replyToMessageId: null,
          attempts: 0,
          attachments: [attachment],
        },
      ],
      [{ email: 'owner@example.com' }],
      [{ authorized: true, quota_claimed: true }],
      [{ user_id: 'user-1', thread_id: null }],
      [],
      [{ id: 'stored' }],
      [],
      [],
      [],
      [],
    ];
    getBlob.mockResolvedValue({
      statusCode: 200,
      stream: new Response('pdf').body,
      blob: { size: 3 },
    });
    resendSend.mockResolvedValue({ data: { id: 'resend-forward' }, error: null });

    const response = await worker.fetch(
      flushRequest({ Authorization: 'Bearer flush-secret' }),
      env,
      ctx,
    );

    expect((await response.json()).sent).toBe(1);
    expect(resendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ filename: 'plan.pdf', content: 'cGRm' })],
      }),
      { idempotencyKey: 'scheduled-send/sched-forward' },
    );
    expect(
      mockQuery.mock.calls.some(([parts]) => parts.join(' ').includes('INSERT INTO attachments')),
    ).toBe(true);
  });

  test('retries a transient claim connection failure', async () => {
    // Real timers: the retry delay is 500ms, and the flush token check
    // awaits WebCrypto before the timer even exists, which makes faked
    // timers race with advanceTimersByTimeAsync.
    const error = Object.assign(new Error('write CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' });
    responses = [error, []];
    const response = await worker.fetch(
      flushRequest({ Authorization: 'Bearer flush-secret' }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      unconfirmed: 0,
    });
    // Failed claim, claim retry, three existing sweeps, then the independent
    // autoresponder arrival, due-delivery and sent-copy scans.
    await Promise.all(waited);
    expect(mockQuery).toHaveBeenCalledTimes(8);
  });

  test('returns 500 after persistent transient claim failures', async () => {
    const error = Object.assign(new Error('Failed to connect to database'), { code: '08006' });
    responses = [error, error, error];
    const response = await worker.fetch(
      flushRequest({ Authorization: 'Bearer flush-secret' }),
      env,
      ctx,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Flush failed' });
    // Scheduled failures preserve their response while the automatic leg runs.
    await Promise.all(waited);
    expect(mockQuery).toHaveBeenCalledTimes(6);
  });

  test('leaves a rate-limited row pending for the next flush instead of spending a retry', async () => {
    responses = [
      [
        {
          id: 'sched-1',
          user_id: 'user-1',
          toAddresses: 'a@b.com',
          subject: 'Hi',
          text: 'Body',
          html: null,
          replyToMessageId: null,
          attempts: 0,
        },
      ],
      [{ email: 'owner@example.com' }],
      [{ authorized: true, quota_claimed: false }],
      [], // revert to 'pending'
    ];
    const response = await worker.fetch(
      flushRequest({ Authorization: 'Bearer flush-secret' }),
      env,
      ctx,
    );

    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 0,
      retried: 1,
      failed: 0,
      unconfirmed: 0,
    });
    expect(resendSend).not.toHaveBeenCalled();
  });

  test('marks a row failed once it has exhausted its retry attempts', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    responses = [
      [
        {
          id: 'sched-1',
          user_id: 'user-1',
          toAddresses: 'a@b.com',
          subject: 'Hi',
          text: 'Body',
          html: null,
          replyToMessageId: null,
          attempts: 4,
        },
      ],
      [{ email: 'owner@example.com' }],
      [{ authorized: true, quota_claimed: true }],
      [], // refund
      [], // mark 'failed'
    ];
    resendSend.mockResolvedValue({ data: null, error: { message: 'bounced' } });
    const response = await worker.fetch(
      flushRequest({ Authorization: 'Bearer flush-secret' }),
      env,
      ctx,
    );

    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 0,
      retried: 0,
      failed: 1,
      unconfirmed: 0,
    });
    expect(consoleError).toHaveBeenCalledWith(
      'scheduled send sched-1 delivery failed (attempt 5):',
      'bounced',
    );
  });

  test('keeps a delivered row leased when marking it sent fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    responses = [
      [
        {
          id: 'sched-1',
          user_id: 'user-1',
          toAddresses: 'recipient@example.com',
          subject: 'Hello',
          text: 'Plain text',
          html: null,
          replyToMessageId: null,
          attempts: 0,
        },
      ],
      [{ email: 'owner@example.com' }],
      [{ authorized: true, quota_claimed: true }],
      [{ user_id: 'user-1', thread_id: null }],
      [], // insert threads
      [{ id: 'stored' }], // insert messages
      new Error('database unavailable'), // mark 'sent' fails
    ];
    resendSend.mockResolvedValue({ data: { id: 'resend-9' }, error: null });
    const response = await worker.fetch(
      flushRequest({ Authorization: 'Bearer flush-secret' }),
      env,
      ctx,
    );

    expect(await response.json()).toEqual({
      claimed: 1,
      sent: 0,
      retried: 0,
      failed: 0,
      unconfirmed: 1,
    });
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'scheduled send sched-1 delivered but could not be marked sent:',
      'database unavailable',
    );
    const queries = mockQuery.mock.calls.map(([parts]) => parts.join(' '));
    expect(queries.some((query) => query.includes("SET status = 'pending'"))).toBe(false);
  });

  test('claims expired sending leases as well as newly due rows', async () => {
    responses = [[]];
    const response = await worker.fetch(
      flushRequest({ Authorization: 'Bearer flush-secret' }),
      env,
      ctx,
    );

    const claimQuery = mockQuery.mock.calls[0][0].join(' ');
    expect(claimQuery).toContain("status = 'sending'");
    expect(claimQuery).toContain('claimed_at < now()');
    expect(await response.json()).toEqual({
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      unconfirmed: 0,
    });
  });
});

describe('routing, auth, and cleanup', () => {
  test('answers OPTIONS from an allowed origin without touching auth', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-send.example/send', {
        method: 'OPTIONS',
        headers: { Origin: PRODUCTION },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(204);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  test('rejects a request that fails verification', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(request('/send', { body: sendBody() }), env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });

  test('an unknown path returns 404', async () => {
    const response = await worker.fetch(request('/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('a GET to /send returns 405', async () => {
    const response = await worker.fetch(request('/send', { method: 'GET' }), env, ctx);
    expect(response.status).toBe(405);
  });

  test('closes the sql connection on a successful request', async () => {
    responses = [[]];
    await worker.fetch(request('/send/scheduled', { method: 'GET' }), env, ctx);
    expect(sqlEnd).toHaveBeenCalledOnce();
  });
});

describe('search indexing of sent mail', () => {
  afterEach(() => {
    // Restore the scripted (call-ordered) driver for suites that rely on it;
    // the batch test below swaps in a statement-dispatching one.
    mockQuery.mockImplementation(scriptedQuery);
  });

  /** The scripted responses for one immediate send that really inserts a row. */
  function storedSendResponses() {
    return [
      [{ authorized: true, quota_claimed: true }], // quota claim
      [{ user_id: USER_ID, thread_id: null }], // storeSentMessage lookup
      [], // insert threads (sql.begin)
      [{ id: 'stored' }], // insert messages (sql.begin), RETURNING id
      [], // read receipt insert
    ];
  }

  /** The message uuid the run actually bound into INSERT INTO messages. */
  function insertedMessageUuids() {
    return mockQuery.mock.calls
      .filter(([parts]) => parts.join(' ').includes('INSERT INTO messages'))
      .map(([, id]) => id);
  }

  function flushRequest() {
    return new Request('https://cookie-web-send.example/send/flush', {
      method: 'POST',
      headers: { Authorization: 'Bearer flush-secret' },
    });
  }

  test('indexes exactly the copy an immediate send stored, on its own connection', async () => {
    responses = storedSendResponses();
    resendSend.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
    const response = await worker.fetch(request('/send', { body: sendBody() }), env, ctx);

    expect(response.status).toBe(200);
    await Promise.all(waited);
    expect(syncMessagesToMeili).not.toHaveBeenCalled();
    expect(syncMessageToMeili).toHaveBeenCalledTimes(1);
    const [syncSql, syncEnv, syncedId] = syncMessageToMeili.mock.calls[0];
    expect(syncedId).toBe(insertedMessageUuids()[0]);
    expect(syncEnv).toEqual(env);
    // fetch closes the request-scoped client as soon as the route returns, so
    // the sync must run on a second client of its own and close that itself.
    expect(clients).toHaveLength(2);
    expect(syncSql).toBe(clients[1]);
    expect(syncSql).not.toBe(clients[0]);
    expect(sqlEnd).toHaveBeenCalledTimes(2);
  });

  test('indexes every copy a flush batch stored in a single sync call', async () => {
    const rows = ['sched-1', 'sched-2'].map((id) => ({
      id,
      user_id: 'user-1',
      toAddresses: 'recipient@example.com',
      subject: 'Hello',
      text: 'Plain text',
      html: null,
      replyToMessageId: null,
      attempts: 0,
    }));
    // The batch runs at FLUSH_CONCURRENCY, so the two rows' statements
    // interleave — dispatch on the statement instead of on call order.
    mockQuery.mockImplementation(
      async (/** @type {any} */ parts, /** @type {any[]} */ ...values) => {
        const query = parts.join(' ');
        if (query.includes('UPDATE scheduled_sends s')) return rows;
        // Checked before the owner probe: the quota claim also selects
        // FROM users, to report `authorized`.
        if (query.includes('outbound_email_quotas')) {
          return [{ authorized: true, quota_claimed: true }];
        }
        if (query.includes('SELECT 1 AS "exists" FROM users')) return [{ exists: 1 }];
        if (query.includes('existing_message_id')) return [{ user_id: 'user-1', thread_id: null }];
        if (query.includes('INSERT INTO messages')) return [{ id: values[0] }];
        return [];
      },
    );
    resendSend.mockResolvedValue({ data: { id: 'resend-9' }, error: null });
    const response = await worker.fetch(flushRequest(), env, ctx);

    expect((await response.json()).sent).toBe(2);
    await Promise.all(waited);
    expect(syncMessageToMeili).not.toHaveBeenCalled();
    expect(syncMessagesToMeili).toHaveBeenCalledTimes(1);
    const stored = insertedMessageUuids();
    expect(stored).toHaveLength(2);
    expect([...syncMessagesToMeili.mock.calls[0][2]].sort()).toEqual([...stored].sort());
  });

  test('indexes nothing new when the send is an idempotent replay', async () => {
    responses = [
      [{ authorized: true, quota_claimed: true }], // quota claim
      // The Resend id already resolves to a stored copy: no INSERT runs at all.
      [{ user_id: USER_ID, thread_id: null, existing_message_id: 'already-stored' }],
      [], // read receipt insert
    ];
    resendSend.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
    const response = await worker.fetch(request('/send', { body: sendBody() }), env, ctx);

    expect(response.status).toBe(200);
    await Promise.all(waited);
    expect(insertedMessageUuids()).toEqual([]);
    expect(syncMessageToMeili).not.toHaveBeenCalled();
    expect(syncMessagesToMeili).not.toHaveBeenCalled();
    // No sync means no second connection was opened either.
    expect(clients).toHaveLength(1);
  });

  test('leaves the send response untouched when indexing fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The real helper swallows its own failures; this covers the seam's own
    // guard, so even a connection that cannot be opened stays off the response.
    syncMessageToMeili.mockRejectedValueOnce(new Error('meilisearch unreachable'));
    responses = storedSendResponses();
    resendSend.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
    const response = await worker.fetch(request('/send', { body: sendBody() }), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'resend-1', messageId: expect.any(String) });
    await expect(Promise.all(waited)).resolves.toBeInstanceOf(Array);
    expect(consoleError).toHaveBeenCalledWith(
      'failed to index sent mail for search:',
      'meilisearch unreachable',
    );
    consoleError.mockRestore();
  });
});
