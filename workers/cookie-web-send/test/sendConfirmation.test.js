import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createSendConfirmation,
  consumeSendConfirmation,
  hashSendConfirmation,
} from '../src/sendConfirmation.js';
import { runAsInternalCaller } from '../../../shared/internal-identity.js';
import { createMockSql } from './helpers.js';

const userId = 'mailbox-owner';
const token = 'ab'.repeat(32);
afterEach(() => vi.restoreAllMocks());

describe('browser send confirmations', () => {
  test('hashes tokens with SHA-256', async () => {
    expect(await hashSendConfirmation('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('refuses an agent identity before accessing the database', async () => {
    const sql = createMockSql();
    const response = await runAsInternalCaller({ userId, email: 'owner@example.com' }, () =>
      createSendConfirmation(sql, userId),
    );
    expect(response.status).toBe(403);
    expect(sql).not.toHaveBeenCalled();
  });

  test('returns a retry interval when the creation quota is exhausted', async () => {
    const sql = createMockSql([[{ allowed: false }]]);
    const response = await createSendConfirmation(sql, userId);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(sql).toHaveBeenCalledOnce();
  });

  test('stores only the hash and returns an uncacheable token with a ten-minute expiry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T12:00:00Z'));
    const sql = createMockSql([[{ allowed: true }], []]);
    const response = await createSendConfirmation(sql, userId);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.confirmation).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresAt).toBe('2026-10-21T12:10:00.000Z');
    expect(sql.calls[1].values).toEqual([
      await hashSendConfirmation(body.confirmation),
      userId,
      body.expiresAt,
    ]);
    expect(sql.calls[1].values).not.toContain(body.confirmation);
  });

  test.each([null, undefined, '', 'AB'.repeat(32), 'a'.repeat(63)])(
    'rejects malformed token %s without a database request',
    async (value) => {
      const sql = createMockSql();
      expect(await consumeSendConfirmation(sql, userId, value, 'request-1')).toMatchObject({
        ok: false,
        status: 403,
        code: 'SEND_CONFIRMATION_REQUIRED',
      });
      expect(sql).not.toHaveBeenCalled();
    },
  );

  test.each(['', 'spaces are invalid', 'a'.repeat(129)])(
    'rejects malformed request ID %s',
    async (requestId) => {
      const sql = createMockSql();
      expect(await consumeSendConfirmation(sql, userId, token, requestId)).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(sql).not.toHaveBeenCalled();
    },
  );

  test('claims a matching permit using its hash, owner and idempotency key', async () => {
    const sql = createMockSql([[{ token_hash: await hashSendConfirmation(token) }]]);
    expect(await consumeSendConfirmation(sql, userId, token, 'request-1')).toEqual({ ok: true });
    expect(sql.calls[0].values).toEqual([
      'request-1',
      await hashSendConfirmation(token),
      userId,
      'request-1',
    ]);
    expect(sql.calls[0].text).toContain('expires_at > now()');
    expect(sql.calls[0].text).toContain('request_id IS NULL OR request_id =');
  });

  test('refuses a claim when no valid matching permit exists', async () => {
    expect(
      await consumeSendConfirmation(createMockSql([[]]), userId, token, 'request-1'),
    ).toMatchObject({ ok: false, status: 403, code: 'SEND_CONFIRMATION_REQUIRED' });
  });

  test.each(['create', 'consume'])(
    'returns an upgrade response when the confirmation table is missing during %s',
    async (operation) => {
      const sql = createMockSql();
      if (operation === 'create') sql.mockResolvedValueOnce([{ allowed: true }]);
      sql.mockRejectedValueOnce(Object.assign(new Error('missing table'), { code: '42P01' }));
      const result =
        operation === 'create'
          ? await createSendConfirmation(sql, userId)
          : await consumeSendConfirmation(sql, userId, token, 'request-1');
      expect(result).toMatchObject({ status: 503 });
    },
  );

  test.each(['create', 'consume'])(
    'propagates unexpected database failures during %s',
    async (operation) => {
      const sql = createMockSql();
      if (operation === 'create') sql.mockResolvedValueOnce([{ allowed: true }]);
      const error = new Error('connection lost');
      sql.mockRejectedValueOnce(error);
      await expect(
        operation === 'create'
          ? createSendConfirmation(sql, userId)
          : consumeSendConfirmation(sql, userId, token, 'request-1'),
      ).rejects.toBe(error);
    },
  );
});
