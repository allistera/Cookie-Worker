import { beforeEach, describe, expect, test } from 'vitest';
import { handleNotificationEvent } from '../src/notificationEvents.js';
import { createMockSql } from './helpers.js';

// Ported from Cookie-Web's api/__tests__/notification-event-handler.test.js —
// same scripted query sequences, same expected statuses and payloads.

const USER_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '11111111-1111-1111-1111-111111111111';
const CLAIM_TOKEN = '22222222-2222-2222-2222-222222222222';
const MESSAGE_ID = '33333333-3333-3333-3333-333333333333';

/** @type {any} */
let sql;

beforeEach(() => {
  sql = createMockSql();
});

describe('claim', () => {
  test('returns the leased event with only the sender and subject', async () => {
    sql = createMockSql([
      [
        {
          event_id: EVENT_ID,
          claim_token: CLAIM_TOKEN,
          claimed_until: '2026-07-30T00:00:30Z',
          message_id: MESSAGE_ID,
          from_name: 'Ana',
          from_address: 'ana@example.com',
          subject: 'Lunch?',
        },
      ],
    ]);

    const response = await handleNotificationEvent(sql, USER_ID, {
      action: 'claim',
      eventId: EVENT_ID,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      eventId: EVENT_ID,
      claimToken: CLAIM_TOKEN,
      message: { id: MESSAGE_ID, sender: 'Ana', subject: 'Lunch?' },
    });
  });

  test('falls back to the sender address when the message has no display name', async () => {
    sql = createMockSql([
      [
        {
          event_id: EVENT_ID,
          claim_token: CLAIM_TOKEN,
          message_id: MESSAGE_ID,
          from_name: null,
          from_address: 'ana@example.com',
          subject: 'Lunch?',
        },
      ],
    ]);

    const response = await handleNotificationEvent(sql, USER_ID, {
      action: 'claim',
      eventId: EVENT_ID,
    });

    expect((await response.json()).message.sender).toBe('ana@example.com');
  });

  // An event already leased by another tab must not produce a second
  // notification; the caller is told to back off rather than given the payload.
  test('423s while another claim still holds the lease', async () => {
    const future = new Date(Date.now() + 30_000).toISOString();
    sql = createMockSql([
      [], // claim matched nothing
      [{ claimed_until: future }], // ...because the lease is live
    ]);

    const response = await handleNotificationEvent(sql, USER_ID, {
      action: 'claim',
      eventId: EVENT_ID,
    });

    expect(response.status).toBe(423);
    expect(response.headers.get('Retry-After')).toBe('30');
    // Retry-After is not CORS-safelisted; the cross-origin SPA only sees it
    // when it is explicitly exposed.
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
  });

  test('204s when the event is gone or no longer eligible', async () => {
    sql = createMockSql([
      [], // claim matched nothing
      [], // no such event for this caller
    ]);

    const response = await handleNotificationEvent(sql, USER_ID, {
      action: 'claim',
      eventId: EVENT_ID,
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  test('204s when a previously expired lease left no live claim', async () => {
    const past = new Date(Date.now() - 30_000).toISOString();
    sql = createMockSql([[], [{ claimed_until: past }]]);

    const response = await handleNotificationEvent(sql, USER_ID, {
      action: 'claim',
      eventId: EVENT_ID,
    });

    expect(response.status).toBe(204);
  });
});

describe('ack', () => {
  test('acknowledges a claim and returns no content', async () => {
    sql = createMockSql([[{ event_id: EVENT_ID }]]);

    const response = await handleNotificationEvent(sql, USER_ID, {
      action: 'ack',
      eventId: EVENT_ID,
      claimToken: CLAIM_TOKEN,
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(sql.calls[0].text).toContain('DELETE FROM browser_notification_events');
    expect(sql.calls[0].text).toContain('event.user_id = ?');
  });

  test('rejects an ack with no claim token', async () => {
    const response = await handleNotificationEvent(sql, USER_ID, {
      action: 'ack',
      eventId: EVENT_ID,
    });

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  test('rejects a malformed claim token', async () => {
    const response = await handleNotificationEvent(sql, USER_ID, {
      action: 'ack',
      eventId: EVENT_ID,
      claimToken: 'nope',
    });

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
});

describe('validation', () => {
  test.each([
    ['an unknown action', { action: 'peek', eventId: EVENT_ID }],
    ['a malformed event id', { action: 'claim', eventId: 'not-a-uuid' }],
    ['a missing event id', { action: 'claim' }],
  ])('rejects %s before touching the database', async (_name, body) => {
    const response = await handleNotificationEvent(sql, USER_ID, body);

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
});
