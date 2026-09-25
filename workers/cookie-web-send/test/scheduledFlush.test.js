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
