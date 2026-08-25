import { describe, expect, test } from 'vitest';
import {
  fetchOwnedReadReceipts,
  handlePixel,
  handleStatus,
  pixelFlooded,
  recordReadReceipt,
} from '../src/readReceipts.js';
import { createMockSql } from './helpers.js';

// Ported from Cookie-Web's api/__tests__/read-receipts.test.js — the query
// shapes and pixel invariants — plus status-route behavior that was only
// covered indirectly there.

const TOKEN = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';

describe('read receipt queries', () => {
  test('records first and subsequent opens using only the opaque token', async () => {
    const sql = createMockSql();

    await recordReadReceipt(sql, TOKEN);

    const query = sql.calls[0];
    expect(query.text).toContain('first_opened_at = COALESCE(first_opened_at, now())');
    expect(query.text).toContain('open_count = open_count + 1');
    expect(query.text).toContain('WHERE token =');
    expect(query.text).toContain('expires_at > now()');
    expect(query.text).toContain("last_opened_at < now() - interval '5 minutes'");
    expect(query.values).toEqual([TOKEN]);
  });

  test('returns statuses only for messages owned by the authenticated user', async () => {
    const sql = createMockSql();
    const ids = [MESSAGE_ID];

    await fetchOwnedReadReceipts(sql, USER_ID, ids);

    const query = sql.calls[0];
    expect(query.text).toContain('WHERE r.user_id =');
    expect(query.text).toContain('r.message_id = ANY');
    expect(query.values).toEqual([USER_ID, ids]);
  });
});

describe('pixel', () => {
  test('returns the same non-cacheable image for an invalid token without touching the database', async () => {
    const sql = createMockSql();

    const response = await handlePixel(sql, 'not-a-token', '203.0.113.1');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(sql.calls).toHaveLength(0);
  });

  test('records a valid token and still returns the identical image', async () => {
    const sql = createMockSql();

    const response = await handlePixel(sql, TOKEN, '203.0.113.2');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(sql.calls[0].text).toContain('UPDATE message_read_receipts');
  });

  test('returns the image even when the database write fails', async () => {
    const sql = createMockSql();
    sql.mockImplementationOnce(() => Promise.reject(new Error('connection reset')));

    const response = await handlePixel(sql, TOKEN, '203.0.113.3');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
  });

  test('flood guard trips after the per-window limit for one address', () => {
    const now = 1_000_000;
    for (let i = 0; i < 120; i += 1) {
      expect(pixelFlooded('198.51.100.9', now)).toBe(false);
    }
    expect(pixelFlooded('198.51.100.9', now)).toBe(true);
    // A fresh window resets the count.
    expect(pixelFlooded('198.51.100.9', now + 60_000)).toBe(false);
    // Other addresses are unaffected.
    expect(pixelFlooded('198.51.100.10', now)).toBe(false);
  });
});

describe('status', () => {
  const url = (ids) =>
    new URL(`https://receipts.example/read-receipts?messageIds=${encodeURIComponent(ids)}`);

  test('returns the receipts for owned messages', async () => {
    const receipt = {
      message_id: MESSAGE_ID,
      first_opened_at: '2026-08-25T00:00:00Z',
      last_opened_at: '2026-08-25T00:05:00Z',
      open_count: 2,
    };
    const sql = createMockSql([[receipt]]);

    const response = await handleStatus(sql, USER_ID, url(MESSAGE_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipts: [receipt] });
  });

  test.each([
    ['no ids', ''],
    ['a malformed id', 'not-a-uuid'],
    ['too many ids', Array.from({ length: 101 }, () => MESSAGE_ID).join(',')],
  ])('rejects %s before touching the database', async (_name, ids) => {
    const sql = createMockSql();

    const response = await handleStatus(sql, USER_ID, url(ids));

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  test('an oversized raw parameter is rejected without being split', async () => {
    const sql = createMockSql();

    const response = await handleStatus(sql, USER_ID, url('a'.repeat(4001)));

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  test('answers with an empty list when the query fails, keeping Sent usable', async () => {
    const sql = createMockSql();
    sql.mockImplementationOnce(() => Promise.reject(new Error('connection reset')));

    const response = await handleStatus(sql, USER_ID, url(MESSAGE_ID));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipts: [] });
  });
});
