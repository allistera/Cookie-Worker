import { expect, test } from 'vitest';
import { createScheduledSend } from '../src/scheduled.js';
import { createMockSql } from './helpers.js';

const send = {
  recipients: ['a@example.com'],
  subject: 'Hello',
  text: 'Body',
  html: null,
  replyToMessageId: null,
  scheduledFor: '2099-01-01T09:00:00.000Z',
  requestId: 'request-1',
};

test('returns the original scheduled row on retry without inserting another delivery', async () => {
  const sql = createMockSql([[], [], [{ id: 'scheduled-1' }]]);
  expect((await createScheduledSend(sql, 'owner', send))?.id).toBe('scheduled-1');
  const insert = sql.calls.find((call) => call.text.includes('INSERT INTO scheduled_sends'));
  const hash = insert.values.find(
    (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  );
  const retry = createMockSql([[], [{ id: 'scheduled-1', requestHash: hash }]]);
  expect(await createScheduledSend(retry, 'owner', send)).toEqual({
    id: 'scheduled-1',
    replayed: true,
  });
  expect(retry.calls.some((call) => call.text.includes('INSERT'))).toBe(false);
  expect(retry.calls[1].values).toEqual(['owner', 'request-1']);
});

test('rejects reuse of the request id for a different payload', async () => {
  const sql = createMockSql([[], [{ id: 'scheduled-1', requestHash: '0'.repeat(64) }]]);
  await expect(createScheduledSend(sql, 'owner', send)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(sql.calls.some((call) => call.text.includes('INSERT'))).toBe(false);
});

test('stores the Cc and Bcc lines in a statement of their own', async () => {
  const sql = createMockSql([[], [{ id: 'scheduled-1' }], []]);
  await createScheduledSend(sql, 'owner', {
    ...send,
    requestId: null,
    cc: ['c@example.com', 'd@example.com'],
    bcc: ['e@example.com'],
  });
  const copies = sql.calls.find((call) => call.text.includes('SET cc_addresses'));
  expect(copies.values).toEqual(['c@example.com, d@example.com', 'e@example.com', 'scheduled-1']);
  // The insert itself names neither column, so mail without copies schedules
  // against a database that has not taken migration 0114 yet.
  const insert = sql.calls.find((call) => call.text.includes('INSERT INTO scheduled_sends'));
  expect(insert.text).not.toMatch(/cc_addresses/);
});

test('leaves the copy columns alone for mail without copies', async () => {
  const sql = createMockSql([[], [{ id: 'scheduled-1' }]]);
  await createScheduledSend(sql, 'owner', { ...send, requestId: null });
  expect(sql.calls.some((call) => call.text.includes('cc_addresses'))).toBe(false);
});

test('a retry that adds a copy is a different request', async () => {
  const sql = createMockSql([[], [], [{ id: 'scheduled-1' }]]);
  await createScheduledSend(sql, 'owner', send);
  const insert = sql.calls.find((call) => call.text.includes('INSERT INTO scheduled_sends'));
  const hash = insert.values.find(
    (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
  );
  const retry = createMockSql([[], [{ id: 'scheduled-1', requestHash: hash }]]);
  await expect(
    createScheduledSend(retry, 'owner', { ...send, cc: ['c@example.com'] }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});

test('continues to support clients without a request id', async () => {
  const sql = createMockSql([[], [{ id: 'legacy-1' }]]);
  expect((await createScheduledSend(sql, 'owner', { ...send, requestId: null }))?.id).toBe(
    'legacy-1',
  );
});

test('links every attachment in one ordered statement', async () => {
  const upload = '22222222-2222-4222-8222-222222222222';
  const inbound = '33333333-3333-4333-8333-333333333333';
  const sql = createMockSql([[], [{ id: 'scheduled-1' }], []]);
  await createScheduledSend(sql, 'owner', {
    ...send,
    requestId: null,
    attachments: [
      { id: upload, source: 'upload' },
      { id: inbound, source: 'inbound' },
    ],
  });
  const links = sql.calls.filter((call) => call.text.includes('scheduled_send_attachments'));
  expect(links).toHaveLength(1);
  expect(links[0].text).toMatch(/WITH ORDINALITY/);
  expect(links[0].values).toContainEqual([upload, inbound]);
  expect(links[0].values).toContainEqual(['upload', 'inbound']);
});
