import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SEND_ERROR_CONTRACT } from '../src/sendErrorContract.js';
import { DeliveryError } from '../src/deliveryLedger.js';
import { deliveryErrorResponse } from '../src/worker.js';
import { consumeSendConfirmation } from '../src/sendConfirmation.js';
import { createMockSql } from './helpers.js';

const token = 'ab'.repeat(32);

/**
 * Returns what the send Worker answers for `code`, from the code path that
 * produces it.
 *
 * @param {string} code
 * @returns {Promise<{status: number, retryAfter: string | null, code: unknown}>}
 */
async function answerFor(code) {
  if (code === 'SEND_CONFIRMATION_REQUIRED' || code === 'SEND_CONFIRMATION_UNAVAILABLE') {
    const sql = createMockSql([[]]);
    if (code === 'SEND_CONFIRMATION_UNAVAILABLE') {
      sql.mockRejectedValueOnce(Object.assign(new Error('missing table'), { code: '42P01' }));
    }
    const permit = await consumeSendConfirmation(sql, 'owner', token, 'request-1');
    if (permit.ok) throw new Error('expected a refused permit');
    return { status: permit.status, retryAfter: null, code: permit.code };
  }
  const response = deliveryErrorResponse(new DeliveryError(code));
  if (!response) throw new Error('expected a delivery error response');
  return {
    status: response.status,
    retryAfter: response.headers.get('Retry-After'),
    code: (await response.json()).code,
  };
}

describe('send error contract', () => {
  test.each(Object.entries(SEND_ERROR_CONTRACT))(
    '%s is answered with its documented status',
    async (code, entry) => {
      expect(await answerFor(code)).toEqual({
        status: entry.status,
        retryAfter: entry.retryAfter,
        code,
      });
    },
  );

  test('the delivery notes list every coded row with the same status', () => {
    const notes = readFileSync(
      new URL('../../../docs/delivery-and-search-recovery.md', import.meta.url),
      'utf8',
    );
    for (const [code, entry] of Object.entries(SEND_ERROR_CONTRACT)) {
      const cells = notes
        .split('\n')
        .map((line) => line.split('|').map((cell) => cell.trim()))
        .find((row) => row[1] === `\`${code}\``);
      expect(cells, code).toBeDefined();
      const status = cells?.[2];
      expect(status, code).toMatch(
        new RegExp(
          `^${entry.status}${entry.retryAfter ? `, \`Retry-After: ${entry.retryAfter}\`` : '($|;)'}`,
        ),
      );
    }
  });
});
