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

  test('redelivers without claiming another quota slot', async () => {
    const sql = scriptedSql([
      [{ exists: 1 }], // owner
      [{ thread_id: null, existing_message_id: 'already-stored' }], // replayed copy lookup
      [], // follow-up repair on the existing copy
      [], // mark sent
    ]);
    const svc = deliveryServices();

    const result = await deliverScheduledSend(sql, dueRow({ reclaimed: true, attempts: 1 }), svc);

    expect(result).toEqual({ status: 'sent', storedMessageUuid: null });
    expect(quotaQueries(sql.calls)).toHaveLength(0);
    expect(svc.send).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: 'scheduled-send/sched-1',
    });
  });

  test('gives back no slot it did not claim when the provider fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sql = scriptedSql([[{ exists: 1 }], []]);
    const svc = deliveryServices({ data: null, error: { message: 'bounced' } });

    const result = await deliverScheduledSend(sql, dueRow({ reclaimed: true, attempts: 1 }), svc);

    expect(result.status).toBe('retried');
    expect(quotaQueries(sql.calls)).toHaveLength(0);
  });
});
