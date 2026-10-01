import { describe, expect, test } from 'vitest';
import { putSenders, getSenders } from '../src/senders.js';
import { outOfOfficeConcurrencyDatabase } from '../../mail-app-ingest/test/outOfOfficeConcurrencyDatabase.js';
import { OWNER, OTHER, MESSAGE } from '../../cookie-web-send/test/autoReplyDatabase.js';

const SECOND = '55555555-5555-4555-8555-555555555555';

describe('sender decisions', () => {
  test('normalizes to a domain decision, preserves unrelated preferences, and isolates other owners', async () => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    state.messages.set(SECOND, { ...state.messages.get(MESSAGE), id: SECOND, user_id: OTHER });
    expect(
      (
        await putSenders(connect(), OTHER, {
          action: 'block',
          address: 'sender@example.com',
          messageId: MESSAGE,
        })
      ).status,
    ).toBe(404);
    const response = await putSenders(connect(), OWNER, {
      action: 'block',
      address: ' Sender@EXAMPLE.com ',
      messageId: MESSAGE,
    });
    expect(await response.json()).toMatchObject({
      address: '@example.com',
      decision: 'blocked',
      effective: 'blocked',
      updated: 1,
    });
    expect(state.messages.get(MESSAGE)).toMatchObject({
      screening_status: 'blocked',
      auto_reply_suppressed: true,
    });
    expect(state.messages.get(SECOND)).toMatchObject({
      screening_status: 'allowed',
      auto_reply_suppressed: false,
    });
    expect(state.users.get(OWNER).theme).toBe('dark');
    expect(state.senderDecisions.size).toBe(1);
  });
  test('retries are idempotent; accepts restore held mail without changing spam, read or archive state', async () => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    const message = state.messages.get(MESSAGE);
    Object.assign(message, {
      screening_status: 'held',
      is_archived: true,
      is_unread: true,
      spam_verdict: 'spam',
      auto_reply_suppressed: true,
    });
    const accept = () =>
      putSenders(connect(), OWNER, { action: 'accept', address: 'sender@example.com' });
    expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBe(200);
    expect(message).toMatchObject({
      screening_status: 'allowed',
      is_archived: true,
      is_unread: true,
      spam_verdict: 'spam',
      auto_reply_suppressed: true,
    });
    expect(state.senderDecisions.size).toBe(1);
    expect(state.deliveries.size).toBe(1);
  });
  test('unblock returns mail to review when screening is on; disabling does not release held mail', async () => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    const sql = connect();
    await putSenders(sql, OWNER, { action: 'settings', enabled: true });
    await putSenders(sql, OWNER, {
      action: 'block',
      address: 'sender@example.com',
      messageId: MESSAGE,
    });
    expect((await putSenders(sql, OWNER, { action: 'restore', messageId: MESSAGE })).status).toBe(
      409,
    );
    await putSenders(sql, OWNER, { action: 'unblock', address: 'sender@example.com' });
    expect(state.messages.get(MESSAGE).screening_status).toBe('held');
    await putSenders(sql, OWNER, { action: 'settings', enabled: false });
    expect(state.messages.get(MESSAGE).screening_status).toBe('held');
    await putSenders(sql, OWNER, { action: 'restore', messageId: MESSAGE });
    expect(state.messages.get(MESSAGE)).toMatchObject({
      screening_status: 'allowed',
      auto_reply_suppressed: true,
    });
    expect(state.senderDecisions.size).toBe(0);
    expect(state.users.get(OWNER).settings.enabled).toBe(true);
  });
  test('concurrent block and accept have one ordered decision and do not move unrelated old mail', async () => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    state.messages.set(SECOND, { ...state.messages.get(MESSAGE), id: SECOND });
    const responses = await Promise.all([
      putSenders(connect(), OWNER, {
        action: 'block',
        address: 'sender@example.com',
        messageId: MESSAGE,
      }),
      putSenders(connect(), OWNER, { action: 'accept', address: 'sender@example.com' }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(state.senderDecisions.get(`${OWNER}/@example.com`)).toBe('accepted');
    expect(state.messages.get(MESSAGE).screening_status).toBe('allowed');
    expect(state.messages.get(SECOND)).toMatchObject({
      screening_status: 'allowed',
      auto_reply_suppressed: true,
    });
    const locks = state.concurrentQueries.filter((row) =>
      row.query.includes('pg_advisory_xact_lock'),
    );
    expect(locks[0].query).toContain("hashtext('cookie.out-of-office')");
  });
  test.each([
    '*@example.com',
    'Name <sender@example.com>',
    'a@example.com,b@example.com',
    '@gmail.com',
    'gmail.com',
  ])('rejects %s (not one address or company domain) before taking locks', async (address) => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    expect((await putSenders(connect(), OWNER, { action: 'block', address })).status).toBe(400);
    expect(state.concurrentQueries).toHaveLength(0);
  });
  test('accept and block cover the whole domain and its subdomains', async () => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    const base = state.messages.get(MESSAGE);
    const add = (id, from_address, from_name, screening_status = 'held') =>
      state.messages.set(id, { ...base, id, from_address, from_name, screening_status });
    add(MESSAGE, 'offers@smarty.co.uk', 'SMARTY');
    add('66666666-6666-4666-8666-666666666661', 'news@email.smarty.co.uk', ' Smarty ');
    add('66666666-6666-4666-8666-666666666662', 'help@smarty.co.uk', 'SMARTY');
    // A lookalike domain, and a different display name on the same domain.
    add('66666666-6666-4666-8666-666666666663', 'x@notsmarty.co.uk', 'SMARTY');
    add('66666666-6666-4666-8666-666666666664', 'y@smarty.co.uk', 'Other');

    const response = await putSenders(connect(), OWNER, {
      action: 'accept',
      address: 'offers@smarty.co.uk',
      messageId: MESSAGE,
    });
    const body = await response.json();

    expect(body).toMatchObject({ address: '@smarty.co.uk', decision: 'accepted', updated: 4 });
    expect(body.related).toEqual([
      'help@smarty.co.uk',
      'news@email.smarty.co.uk',
      'y@smarty.co.uk',
    ]);
    const status = (id) => state.messages.get(id).screening_status;
    expect(status(MESSAGE)).toBe('allowed');
    expect(status('66666666-6666-4666-8666-666666666661')).toBe('allowed');
    expect(status('66666666-6666-4666-8666-666666666662')).toBe('allowed');
    expect(status('66666666-6666-4666-8666-666666666663')).toBe('held');
    expect(status('66666666-6666-4666-8666-666666666664')).toBe('allowed');
    expect([...state.senderDecisions.keys()]).toEqual([`${OWNER}/@smarty.co.uk`]);

    const blocked = await putSenders(connect(), OWNER, {
      action: 'block',
      address: 'x@notsmarty.co.uk',
      messageId: '66666666-6666-4666-8666-666666666663',
    });
    expect(await blocked.json()).toMatchObject({ address: '@notsmarty.co.uk', related: [] });
  });

  test('public email providers keep exact-address decisions', async () => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    const base = state.messages.get(MESSAGE);
    state.messages.set(MESSAGE, {
      ...base,
      from_address: 'friend@gmail.com',
      screening_status: 'held',
    });
    state.messages.set(SECOND, {
      ...base,
      id: SECOND,
      from_address: 'stranger@gmail.com',
      screening_status: 'held',
    });

    const response = await putSenders(connect(), OWNER, {
      action: 'accept',
      address: 'Friend@Gmail.com',
    });

    expect(await response.json()).toMatchObject({ address: 'friend@gmail.com', related: [] });
    expect(state.messages.get(MESSAGE).screening_status).toBe('allowed');
    expect(state.messages.get(SECOND).screening_status).toBe('held');
  });

  test('an exact-address decision overrides its domain, and lookups report what applies', async () => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    state.senderDecisions.set(`${OWNER}/vip@badco.example`, 'accepted');
    await putSenders(connect(), OWNER, { action: 'block', address: 'badco.example' });
    const lookup = async (address) =>
      (
        await getSenders(
          connect(),
          OWNER,
          new URL(`https://example.com/emails/senders?address=${encodeURIComponent(address)}`),
        )
      ).json();

    expect((await lookup('vip@badco.example')).decisions).toEqual([
      { address: 'vip@badco.example', decision: 'accepted' },
    ]);
    expect((await lookup('spam@mail.badco.example')).decisions).toEqual([
      { address: '@badco.example', decision: 'blocked' },
    ]);
    expect((await lookup('someone@elsewhere.example')).decisions).toEqual([]);

    // Unblocking from one of the domain's senders removes the domain decision.
    await putSenders(connect(), OWNER, { action: 'unblock', address: 'spam@badco.example' });
    expect([...state.senderDecisions.keys()]).toEqual([`${OWNER}/vip@badco.example`]);
  });

  test("a decision made from a sender replaces that sender's own older exact decision", async () => {
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    state.senderDecisions.set(`${OWNER}/sender@example.com`, 'accepted');
    const response = await putSenders(connect(), OWNER, {
      action: 'block',
      address: 'sender@example.com',
      messageId: MESSAGE,
    });
    expect(await response.json()).toMatchObject({ address: '@example.com', effective: 'blocked' });
    expect(state.messages.get(MESSAGE).screening_status).toBe('blocked');
    expect([...state.senderDecisions.entries()]).toEqual([[`${OWNER}/@example.com`, 'blocked']]);
  });

  test('lists only the verified owner with bounded cursor pages and private caching', async () => {
    const calls = [];
    const rows = Array.from({ length: 51 }, (_, i) => ({
      address: `sender${String(i).padStart(2, '0')}@example.com`,
      decision: 'blocked',
    }));
    const sql = /** @type {any} */ (
      (parts, ...values) => {
        const query = parts.join('?');
        calls.push({ query, values });
        return query.includes('FROM users')
          ? [{ enabled: false }]
          : query.includes('FROM sender_decisions')
            ? rows
            : [];
      }
    );
    const response = await getSenders(sql, OWNER, new URL('https://example.com/emails/senders'));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      enabled: false,
      decisions: rows.slice(0, 50),
      nextCursor: rows[49].address,
    });
    expect(calls.find((row) => row.query.includes('FROM sender_decisions')).values).toContain(
      OWNER,
    );
  });
});
