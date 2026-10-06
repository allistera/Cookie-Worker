import { describe, expect, test, vi } from 'vitest';
import { deliverScheduledSend, handleFlush } from '../src/scheduled.js';
import { createMockSql } from './helpers.js';

function services() {
  return /** @type {any} */ ({
    indexSentMessages: vi.fn(),
    deleteBlob: vi.fn(async () => undefined),
  });
}

/** @param {any} sql */
function orphanSweep(sql) {
  const sweep = sql.calls.find((/** @type {{text: string}} */ call) =>
    call.text.includes('DELETE FROM outbound_attachments'),
  );
  if (!sweep) throw new Error('Expected the orphaned-upload sweep to run');
  return sweep;
}

describe('expired lease reclaim', () => {
  test('counts reclaiming an expired sending lease as a delivery attempt', async () => {
    const sql = createMockSql();
    await handleFlush(sql, services());

    const claim = sql.calls[0].text;
    expect(claim).toContain("status = 'sending'");
    // A delivery that kills the isolate never reaches the thrown-error path,
    // so the reclaim itself is what moves the row toward its attempt cap.
    expect(claim).toMatch(/attempts = s\.attempts \+ CASE WHEN s\.status = 'sending' THEN 1/);
  });

  test('marks a reclaimed row failed without resending once attempts are exhausted', async () => {
    const sql = createMockSql([[]]);
    const svc = services();
    const result = await deliverScheduledSend(
      sql,
      { id: 'sched-1', user_id: 'user-1', toAddresses: 'a@b.com', attempts: 5, attachments: [] },
      svc,
    );

    expect(result).toEqual({ status: 'failed', storedMessageUuid: null });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain("SET status = 'failed'");
    expect(sql.calls[0].values).toContain('sched-1');
    // No owner lookup or quota claim: the row is resolved before any send work.
    expect(
      sql.calls.some((/** @type {{text: string}} */ call) => call.text.includes('users')),
    ).toBe(false);
  });
});

describe('orphaned-upload sweep', () => {
  test('only deletes uploads older than the 24-hour window', async () => {
    const sql = createMockSql();
    await handleFlush(sql, services());

    const sweep = orphanSweep(sql);
    expect(sweep.text).toMatch(/candidate\.created_at\s+< now\(\) - make_interval\(hours => \?\)/);
    expect(sweep.values[0]).toBe(24);
  });

  test('keeps uploads a scheduled send or a saved draft still references', async () => {
    const sql = createMockSql();
    await handleFlush(sql, services());

    const sweep = orphanSweep(sql);
    expect(sweep.text).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM scheduled_send_attachments ssa\s+WHERE ssa\.outbound_attachment_id = candidate\.id/,
    );
    expect(sweep.text).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM draft_attachments da\s+WHERE da\.outbound_attachment_id = candidate\.id/,
    );
  });

  test('deletes an orphan blob but keeps one a sent copy still shares', async () => {
    const sql = createMockSql([
      [], // claim
      [], // resolved scheduled_sends sweep
      [], // expired read receipts sweep
      [
        { blob_url: 'https://blob.example/orphan.pdf', blobUnreferenced: true },
        { blob_url: 'https://blob.example/sent-copy.pdf', blobUnreferenced: false },
      ],
    ]);
    const svc = services();
    const response = await handleFlush(sql, svc);

    expect(response.status).toBe(200);
    expect(orphanSweep(sql).text).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM attachments a WHERE a\.blob_url = oa\.blob_url/,
    );
    expect(svc.deleteBlob).toHaveBeenCalledTimes(1);
    expect(svc.deleteBlob).toHaveBeenCalledWith('https://blob.example/orphan.pdf');
  });

  test('keeps sweeping and still answers the flush when one blob delete fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = createMockSql([
      [],
      [],
      [],
      [
        { blob_url: 'https://blob.example/first.pdf', blobUnreferenced: true },
        { blob_url: 'https://blob.example/second.pdf', blobUnreferenced: true },
      ],
    ]);
    const svc = services();
    svc.deleteBlob.mockRejectedValueOnce(new Error('blob store unavailable'));
    const response = await handleFlush(sql, svc);

    expect(response.status).toBe(200);
    expect(svc.deleteBlob).toHaveBeenCalledTimes(2);
    expect(svc.deleteBlob).toHaveBeenLastCalledWith('https://blob.example/second.pdf');
    expect(consoleError).toHaveBeenCalledWith(
      'failed to delete orphaned attachment blob:',
      'blob store unavailable',
    );
  });
});

/**
 * Like createMockSql, but an Error in the script rejects that query, so a
 * test can drop the connection under one specific statement.
 *
 * @param {unknown[]} script
 * @returns {any}
 */
function scriptedSql(script) {
  const queue = [...script];
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  /** @type {any} */
  const sql = vi.fn((/** @type {string[]} */ strings, /** @type {unknown[]} */ ...values) => {
    calls.push({ text: strings.join('?'), values });
    const next = queue.length ? queue.shift() : [];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  sql.begin = vi.fn(async (/** @type {(sql: any) => unknown} */ callback) => callback(sql));
  sql.calls = calls;
  return sql;
}

/** @param {{data: unknown, error: unknown}} result */
function deliveryServices(result = { data: { id: 'resend-9' }, error: null }) {
  const send = vi.fn(async () => result);
  return /** @type {any} */ ({
    env: { RESEND_API_KEY: 'key', EMAIL_FROM: 'Cookie <mail@example.com>' },
    createResend: () => ({ emails: { send } }),
    readBlob: vi.fn(),
    indexSentMessages: vi.fn(),
    send,
  });
}

const dueRow = (/** @type {Record<string, unknown>} */ overrides = {}) => ({
  id: 'sched-1',
  user_id: 'user-1',
  toAddresses: 'recipient@example.com',
  subject: 'Hello',
  text: 'Plain text',
  html: null,
  replyToMessageId: null,
  attempts: 0,
  attachments: [],
  followUpAt: '2099-01-01T09:00:00.000Z',
  ...overrides,
});

const dropped = () => new Error('Network connection lost.');

/** @param {{text: string}[]} calls */
function quotaQueries(calls) {
  return calls.filter((call) => call.text.includes('outbound_email_quotas'));
}

describe('a scheduled send the provider accepted', () => {
  test('repairs a sent copy that failed to store and records the row sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = scriptedSql([
      [{ exists: 1 }], // owner
      [{ authorized: true, quota_claimed: true }], // quota claim
      dropped(), // deliverMail's sent-copy lookup
      [{ thread_id: null, existing_message_id: null }], // repair lookup
      [], // insert thread
      [{ id: 'stored' }], // insert message
      [], // mark sent
    ]);
    const svc = deliveryServices();

    const result = await deliverScheduledSend(sql, dueRow(), svc);

    expect(result.status).toBe('sent');
    expect(result.storedMessageUuid).toEqual(expect.any(String));
    expect(svc.send).toHaveBeenCalledTimes(1);
    const markSent = sql.calls.at(-1);
    expect(markSent.text).toContain("SET status = 'sent'");
    expect(markSent.values).toContain(result.storedMessageUuid);
    // The repaired copy still carries the follow-up reminder.
    const insert = sql.calls.find((/** @type {{text: string}} */ call) =>
      call.text.includes('INSERT INTO messages'),
    );
    expect(insert.values).toContain('2099-01-01T09:00:00.000Z');
  });

  test('is recorded sent, not left leased, when the sent copy cannot be stored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = scriptedSql([
      [{ exists: 1 }],
      [{ authorized: true, quota_claimed: true }],
      dropped(), // deliverMail's sent-copy lookup
      dropped(), // repair attempt 1
      dropped(), // repair attempt 2
      [], // mark sent
    ]);
    const svc = deliveryServices();

    const result = await deliverScheduledSend(sql, dueRow(), svc);

    expect(result).toEqual({ status: 'sent', storedMessageUuid: null });
    const markSent = sql.calls.at(-1);
    expect(markSent.text).toContain("SET status = 'sent'");
    expect(markSent.values).toContain(
      'Sent as provider message resend-9, but the sent copy could not be saved',
    );
    // Neither resent nor refunded: the mail went out once and its slot stands.
    expect(svc.send).toHaveBeenCalledTimes(1);
    expect(quotaQueries(sql.calls)).toHaveLength(1);
    expect(
      sql.calls.some((/** @type {{text: string}} */ call) => call.text.includes("'pending'")),
    ).toBe(false);
  });
});

describe('a reclaimed lease', () => {
  test('claims as an expired lease and reports it as reclaimed', async () => {
    const sql = createMockSql();
    await handleFlush(sql, services());
    expect(sql.calls[0].text).toContain("status = 'sending' AS reclaimed");
    expect(sql.calls[0].text).toContain('due.reclaimed');
  });

  test('claims a quota slot, then gives it back when the provider deduplicated the redelivery', async () => {
    const sql = scriptedSql([
      [{ exists: 1 }], // owner
      [{ authorized: true, quota_claimed: true }], // quota claim
      [{ thread_id: null, existing_message_id: 'already-stored' }], // replayed copy lookup
      [], // follow-up repair on the existing copy
      [], // refund: nothing new went out
      [], // mark sent
    ]);
    const svc = deliveryServices();

    const result = await deliverScheduledSend(sql, dueRow({ reclaimed: true, attempts: 1 }), svc);

    expect(result).toEqual({ status: 'sent', storedMessageUuid: null });
    const quota = quotaQueries(sql.calls);
    expect(quota).toHaveLength(2);
    expect(quota[0].text).toContain('INSERT INTO outbound_email_quotas');
    expect(quota[1].text).toContain('send_count - 1');
    expect(svc.send).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: 'scheduled-send/sched-1',
    });
  });

  test('charges a reclaimed lease whose earlier attempt never sent, keeping the slot', async () => {
    // The first attempt died before (or after refunding) its quota claim, so
    // nothing went out and nothing was stored: this delivery is the real send.
    const sql = scriptedSql([
      [{ exists: 1 }], // owner
      [{ authorized: true, quota_claimed: true }], // quota claim
      [{ thread_id: null, existing_message_id: null }], // sent-copy lookup
      [], // insert thread
      [{ id: 'stored' }], // insert message
      [], // mark sent
    ]);
    const svc = deliveryServices();

    const result = await deliverScheduledSend(sql, dueRow({ reclaimed: true, attempts: 1 }), svc);

    expect(result.status).toBe('sent');
    expect(result.storedMessageUuid).toEqual(expect.any(String));
    const quota = quotaQueries(sql.calls);
    expect(quota).toHaveLength(1);
    expect(quota[0].text).toContain('INSERT INTO outbound_email_quotas');
  });

  test('leaves a rate-limited reclaimed lease pending without sending', async () => {
    const sql = scriptedSql([
      [{ exists: 1 }],
      [{ authorized: true, quota_claimed: false }],
      [], // back to pending
    ]);
    const svc = deliveryServices();

    const result = await deliverScheduledSend(sql, dueRow({ reclaimed: true, attempts: 1 }), svc);

    expect(result).toEqual({ status: 'retried', storedMessageUuid: null });
    expect(svc.send).not.toHaveBeenCalled();
    expect(sql.calls.at(-1).text).toContain("SET status = 'pending'");
  });

  test('refunds the slot it claimed when the provider fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = scriptedSql([
      [{ exists: 1 }],
      [{ authorized: true, quota_claimed: true }],
      [], // refund
      [], // back to pending
    ]);
    const svc = deliveryServices({ data: null, error: { message: 'bounced' } });

    const result = await deliverScheduledSend(sql, dueRow({ reclaimed: true, attempts: 1 }), svc);

    expect(result.status).toBe('retried');
    const quota = quotaQueries(sql.calls);
    expect(quota).toHaveLength(2);
    expect(quota[1].text).toContain('send_count - 1');
  });
});

/**
 * Answers by statement rather than call order, for flushes whose rows are
 * delivered concurrently. `owner` decides each row's owner lookup.
 *
 * @param {any[]} claimed
 * @param {(userId: unknown) => unknown} owner
 * @returns {any}
 */
function flushSql(claimed, owner = () => [{ exists: 1 }]) {
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  /** @type {any} */
  const sql = vi.fn(async (/** @type {string[]} */ strings, /** @type {unknown[]} */ ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('UPDATE scheduled_sends s')) return claimed;
    if (text.includes('WITH claimed AS')) return [{ authorized: true, quota_claimed: true }];
    if (text.includes('FROM users WHERE id')) {
      const result = owner(values[0]);
      if (result instanceof Error) throw result;
      return result;
    }
    if (text.includes('existing_message_id'))
      return [{ thread_id: null, existing_message_id: null }];
    if (text.includes('INSERT INTO messages')) return [{ id: values[0] }];
    return [];
  });
  sql.begin = vi.fn(async (/** @type {(sql: any) => unknown} */ callback) => callback(sql));
  sql.calls = calls;
  return sql;
}

/** @param {number} count */
const attachmentList = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `att-${index}`,
    filename: `${index}.pdf`,
    blob_url: `https://blob.example/${index}.pdf`,
  }));

describe('a flush whose bookkeeping throws for one row', () => {
  test('still delivers, indexes and sweeps the rest, and releases that row for a retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = flushSql(
      [dueRow({ id: 'sched-a', user_id: 'user-bad' }), dueRow({ id: 'sched-b' })],
      (userId) => (userId === 'user-bad' ? new Error('Connection reset') : [{ exists: 1 }]),
    );
    const svc = deliveryServices();
    svc.deleteBlob = vi.fn();

    const response = await handleFlush(sql, svc);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 2,
      sent: 1,
      retried: 1,
      failed: 0,
      unconfirmed: 0,
    });
    expect(svc.send).toHaveBeenCalledTimes(1);
    expect(svc.indexSentMessages).toHaveBeenCalledWith([expect.any(String)]);
    const release = sql.calls.find((/** @type {{text: string}} */ call) =>
      call.text.includes('attempts = attempts + 1'),
    );
    expect(release.values).toEqual(['Connection reset', 'sched-a']);
    expect(release.text).toContain("status = 'sending'");
    orphanSweep(sql);
  });

  test('answers the flush even when the release write fails too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = flushSql([dueRow({ id: 'sched-a' })], () => new Error('Connection reset'));
    const base = sql.getMockImplementation();
    sql.mockImplementation(async (/** @type {string[]} */ strings, ...values) => {
      if (strings.join('?').includes('attempts = attempts + 1')) throw new Error('still down');
      return base(strings, ...values);
    });

    const response = await handleFlush(sql, deliveryServices());

    expect(response.status).toBe(200);
    expect((await response.json()).retried).toBe(1);
  });
});

describe('the flush subrequest budget', () => {
  test('claims rows against a running cost of one provider call plus one Blob read each', async () => {
    const sql = createMockSql();
    await handleFlush(sql, services());
    const claim = sql.calls[0];
    expect(claim.text).toContain('FROM scheduled_send_attachments ssa');
    expect(claim.text).toContain('sum(cost) OVER (ORDER BY scheduled_for, id) AS running_cost');
    // The first row always fits; the rest only while the running total does.
    expect(claim.text).toMatch(/due\.running_cost = due\.cost OR due\.running_cost <= \?/);
    expect(claim.values).toContain(20);
  });

  test('a light batch sweeps at most ten orphaned uploads', async () => {
    const sql = createMockSql();
    await handleFlush(sql, services());
    expect(orphanSweep(sql).values.at(-1)).toBe(10);
  });

  test('a heavy batch shrinks the orphaned-upload sweep to what is left', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 1 provider call + 25 Blob reads leaves 4 of the 30-call budget.
    const sql = flushSql([dueRow({ attachments: attachmentList(25) })], () => new Error('down'));
    await handleFlush(sql, deliveryServices());
    expect(orphanSweep(sql).values.at(-1)).toBe(4);
  });

  test('a batch that spent the budget skips the orphaned-upload sweep', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 1 provider call + 29 Blob reads: the first row is claimed whatever it
    // costs, and nothing is left for Blob deletes.
    const sql = flushSql([dueRow({ attachments: attachmentList(29) })], () => new Error('down'));
    const svc = deliveryServices();
    svc.deleteBlob = vi.fn();
    const response = await handleFlush(sql, svc);
    expect(response.status).toBe(200);
    expect(
      sql.calls.some((/** @type {{text: string}} */ call) =>
        call.text.includes('DELETE FROM outbound_attachments'),
      ),
    ).toBe(false);
    // The resolved-state sweep is Postgres-only and still runs.
    expect(
      sql.calls.some((/** @type {{text: string}} */ call) =>
        call.text.includes('DELETE FROM scheduled_sends'),
      ),
    ).toBe(true);
  });
});
