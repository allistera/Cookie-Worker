import { describe, expect, test } from 'vitest';
import {
  createDraft,
  deleteDraft,
  isEmptyDraft,
  listDrafts,
  setDraftStar,
  parseDraftBody,
  updateDraft,
} from '../src/drafts.js';
import { createMockSql } from './helpers.js';

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';

const draft = (overrides = {}) => ({ to: 'a@b.com', subject: 'Hi', text: 'Body', ...overrides });

/**
 * parseDraftBody returns null for input it refuses; the tests below that use
 * this helper are asserting on accepted input, so narrow it once here.
 *
 * @param {any} body
 */
function accepted(body) {
  const parsed = parseDraftBody(body);
  if (!parsed) throw new Error('expected parseDraftBody to accept this body');
  return parsed;
}

describe('parseDraftBody', () => {
  test('normalises an ordinary autosave payload', () => {
    expect(parseDraftBody(draft())).toMatchObject({
      toAddresses: 'a@b.com',
      subject: 'Hi',
      text: 'Body',
      html: null,
      replyToMessageId: null,
      attachmentIds: [],
    });
  });

  test('keeps the Cc and Bcc lines, and tells an absent line from an emptied one', () => {
    expect(accepted(draft({ cc: 'c@d.com', bcc: '' }))).toMatchObject({
      ccAddresses: 'c@d.com',
      bccAddresses: '',
    });
    expect(accepted(draft())).toMatchObject({ ccAddresses: null, bccAddresses: null });
    expect(parseDraftBody(draft({ cc: 'x'.repeat(10_241) }))).toBeNull();
  });

  test('drops a reply target that is not a real id rather than failing the save', () => {
    // Fixture ids from e2e/dev mode are not UUIDs; losing the threading is
    // preferable to losing the text.
    expect(accepted(draft({ replyToMessageId: 'fixture-1' })).replyToMessageId).toBeNull();
  });

  test.each([
    [{ subject: 'x'.repeat(999) }, 'subject over the header limit'],
    [{ text: 'x'.repeat(100_001) }, 'text past the outbound ceiling'],
    [{ html: 'x'.repeat(200_001) }, 'html past the outbound ceiling'],
    [{ attachmentIds: [ATTACHMENT_ID, ATTACHMENT_ID] }, 'duplicate attachment ids'],
    [{ attachmentIds: ['not-a-uuid'] }, 'malformed attachment id'],
    [{ followUpAt: 'whenever' }, 'unparseable follow-up'],
    // Each field is individually legal here; only their sum is not.
    [{ text: 'x'.repeat(90_000), html: 'y'.repeat(180_000) }, 'aggregate over the send ceiling'],
  ])('refuses a draft the send API would later reject: %s', (overrides, _label) => {
    expect(parseDraftBody(draft(overrides))).toBeNull();
  });
});

describe('recipient field bound', () => {
  test('accepts the longest recipient list the send path allows', () => {
    // cookie-web-send bounds this field at MAX_OUTBOUND_RECIPIENTS * 512;
    // a tighter cap here would reject drafts that are perfectly sendable.
    const longest = Array.from({ length: 20 }, () => `${'a'.repeat(240)}@example.com`).join(', ');
    expect(accepted({ to: longest, text: 'Body' }).toAddresses).toBe(longest);
  });
});

describe('isEmptyDraft', () => {
  test('treats whitespace-only content as empty', () => {
    expect(isEmptyDraft(accepted({ to: ' ', subject: '', text: '  \n ' }))).toBe(true);
  });

  test('a Cc or Bcc address alone is enough to be worth keeping', () => {
    const blank = { to: '', subject: '', text: '' };
    expect(isEmptyDraft(accepted({ ...blank, cc: 'c@d.com' }))).toBe(false);
    expect(isEmptyDraft(accepted({ ...blank, bcc: 'c@d.com' }))).toBe(false);
    expect(isEmptyDraft(accepted({ ...blank, cc: ' ', bcc: '' }))).toBe(true);
  });

  test('an attachment alone is enough to be worth keeping', () => {
    expect(isEmptyDraft(accepted({ to: '', text: '', attachmentIds: [ATTACHMENT_ID] }))).toBe(
      false,
    );
  });
});

describe('createDraft', () => {
  test('stores the first autosave and returns the id the composer reuses', async () => {
    const sql = createMockSql([[], [{ id: DRAFT_ID, updatedAt: '2026-09-03T10:00:00Z' }], []]);
    const response = await createDraft(sql, USER_ID, draft());
    expect(response.status).toBe(201);
    expect((await response.json()).draft.id).toBe(DRAFT_ID);
  });

  test('never creates a row for an untouched composer', async () => {
    const sql = createMockSql();
    const response = await createDraft(sql, USER_ID, { to: '', subject: '', text: '' });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('refuses once the per-user draft cap is reached', async () => {
    // The advisory lock, then the guarded INSERT ... WHERE count < cap
    // returning no row.
    const sql = createMockSql([[], [], []]);
    const response = await createDraft(sql, USER_ID, draft());
    expect(response.status).toBe(429);
  });

  test('takes a per-user lock so two autosaves cannot both claim the last slot', async () => {
    const sql = createMockSql([[], [{ id: DRAFT_ID, updatedAt: 'now' }], []]);
    await createDraft(sql, USER_ID, draft());
    expect(sql.calls[0].text).toMatch(/pg_advisory_xact_lock/);
  });

  test('writes the Cc and Bcc lines only when the draft has them', async () => {
    const sql = createMockSql([[], [{ id: DRAFT_ID, updatedAt: 'now' }], []]);
    await createDraft(sql, USER_ID, draft({ cc: 'c@d.com', bcc: 'e@f.com' }));
    const copies = sql.calls.find((call) => call.text.includes('SET cc_addresses'));
    expect(copies.values).toEqual(['c@d.com', 'e@f.com', DRAFT_ID]);

    const plain = createMockSql([[], [{ id: DRAFT_ID, updatedAt: 'now' }], []]);
    await createDraft(plain, USER_ID, draft({ cc: '', bcc: '' }));
    expect(plain.calls.some((call) => call.text.includes('cc_addresses'))).toBe(false);
  });

  test("resolves the reply target against the user's own messages so a purged id cannot fail the FK", async () => {
    const REPLY_ID = '33333333-3333-4333-8333-333333333333';
    const sql = createMockSql([[], [{ id: DRAFT_ID, updatedAt: 'now' }], []]);
    await createDraft(sql, USER_ID, draft({ replyToMessageId: REPLY_ID }));
    const insert = sql.calls[1];
    expect(insert.text).toMatch(
      /SELECT m\.id FROM messages m\s+WHERE m\.id = \?::uuid AND m\.user_id = \?/,
    );
    expect(insert.values).toEqual(expect.arrayContaining([REPLY_ID, USER_ID]));
  });
});

describe('updateDraft', () => {
  test('replaces the whole draft rather than merging fields', async () => {
    const sql = createMockSql([[{ id: DRAFT_ID, updatedAt: 'now' }], [], []]);
    const response = await updateDraft(sql, USER_ID, DRAFT_ID, draft({ subject: 'Changed' }));
    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toMatch(/UPDATE drafts/);
    expect(sql.calls[0].values).toContain('Changed');
  });

  test("resolves the reply target against the user's own messages", async () => {
    const sql = createMockSql([[{ id: DRAFT_ID, updatedAt: 'now' }], [], []]);
    await updateDraft(sql, USER_ID, DRAFT_ID, draft());
    expect(sql.calls[0].text).toMatch(/reply_to_message_id = \(SELECT m\.id FROM messages m/);
    expect(sql.calls[0].text).toMatch(/m\.user_id = \?/);
  });

  test('404s a draft belonging to someone else', async () => {
    const sql = createMockSql([[]]);
    const response = await updateDraft(sql, USER_ID, DRAFT_ID, draft());
    expect(response.status).toBe(404);
  });

  test('deletes the row when the composer is cleared out', async () => {
    const sql = createMockSql([[{ id: DRAFT_ID }]]);
    const response = await updateDraft(sql, USER_ID, DRAFT_ID, { to: '', subject: '', text: '' });
    expect(response.status).toBe(204);
    expect(sql.calls[0].text).toMatch(/DELETE FROM drafts/);
  });

  test('keeps only attachments the user actually owns', async () => {
    const foreignId = '33333333-3333-4333-8333-333333333333';
    const sql = createMockSql([
      [{ id: DRAFT_ID, updatedAt: 'now' }],
      [], // DELETE draft_attachments
      [{ id: ATTACHMENT_ID, source: 'upload' }], // ownership lookup: only one is owned
      [], // the single INSERT
    ]);
    const response = await updateDraft(
      sql,
      USER_ID,
      DRAFT_ID,
      draft({ attachmentIds: [ATTACHMENT_ID, foreignId] }),
    );
    expect(response.status).toBe(200);
    const inserts = sql.calls.filter((call) => /INSERT INTO draft_attachments/.test(call.text));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toContainEqual([ATTACHMENT_ID]);
    expect(inserts[0].values).toContainEqual(['upload']);
    expect(JSON.stringify(inserts[0].values)).not.toContain(foreignId);
  });

  test('writes the whole attachment list in one ordered statement', async () => {
    const second = '44444444-4444-4444-8444-444444444444';
    const sql = createMockSql([
      [{ id: DRAFT_ID, updatedAt: 'now', attachmentIds: [] }],
      [
        { id: second, source: 'inbound' },
        { id: ATTACHMENT_ID, source: 'upload' },
      ],
      [],
    ]);
    await updateDraft(sql, USER_ID, DRAFT_ID, draft({ attachmentIds: [ATTACHMENT_ID, second] }));
    const inserts = sql.calls.filter((call) => /INSERT INTO draft_attachments/.test(call.text));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].text).toMatch(/unnest\(\?::uuid\[\], \?::text\[\]\) WITH ORDINALITY/);
    // The composer's order, not the ownership lookup's.
    expect(inserts[0].values).toContainEqual([ATTACHMENT_ID, second]);
    expect(inserts[0].values).toContainEqual(['upload', 'inbound']);
    // The draft had no attachments, so there was nothing to delete.
    expect(sql.calls.some((call) => /DELETE FROM draft_attachments/.test(call.text))).toBe(false);
  });

  test('leaves an unchanged attachment list alone on autosave', async () => {
    const sql = createMockSql([
      [{ id: DRAFT_ID, updatedAt: 'now', attachmentIds: [ATTACHMENT_ID] }],
    ]);
    const response = await updateDraft(
      sql,
      USER_ID,
      DRAFT_ID,
      draft({ attachmentIds: [ATTACHMENT_ID.toUpperCase()] }),
    );
    expect(response.status).toBe(200);
    expect(sql.calls).toHaveLength(1);
  });

  test('replaces the list when an attachment is removed', async () => {
    const sql = createMockSql([
      [{ id: DRAFT_ID, updatedAt: 'now', attachmentIds: [ATTACHMENT_ID] }],
      [], // DELETE draft_attachments
    ]);
    await updateDraft(sql, USER_ID, DRAFT_ID, draft({ attachmentIds: [] }));
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[1].text).toMatch(/DELETE FROM draft_attachments/);
  });
});

describe('updateDraft Cc and Bcc', () => {
  const stored = (/** @type {Record<string, unknown>} */ copies) => [
    { id: DRAFT_ID, updatedAt: 'now', attachmentIds: [], ...copies },
  ];
  const copyWrites = (/** @type {any} */ sql) =>
    sql.calls.filter((/** @type {{text: string}} */ call) =>
      call.text.includes('SET cc_addresses'),
    );

  test('writes the lines when they changed, including when one is cleared', async () => {
    const sql = createMockSql([stored({ cc: 'c@d.com', bcc: 'e@f.com' }), []]);
    await updateDraft(sql, USER_ID, DRAFT_ID, draft({ cc: 'c@d.com', bcc: '' }));
    expect(copyWrites(sql)).toHaveLength(1);
    expect(copyWrites(sql)[0].values).toEqual(['c@d.com', '', DRAFT_ID]);
  });

  test('leaves unchanged lines alone on autosave', async () => {
    const sql = createMockSql([stored({ cc: 'c@d.com', bcc: '' })]);
    await updateDraft(sql, USER_ID, DRAFT_ID, draft({ cc: 'c@d.com', bcc: '' }));
    expect(sql.calls).toHaveLength(1);
  });

  test('a client that sends neither line does not wipe the stored ones', async () => {
    const sql = createMockSql([stored({ cc: 'c@d.com', bcc: 'e@f.com' })]);
    await updateDraft(sql, USER_ID, DRAFT_ID, draft());
    expect(sql.calls).toHaveLength(1);
  });

  test('saves a draft without copies before the columns exist', async () => {
    // The main UPDATE names neither column and reads them through to_jsonb,
    // which answers NULL (here: no value at all) until migration 0114 lands.
    const sql = createMockSql([stored({})]);
    const response = await updateDraft(sql, USER_ID, DRAFT_ID, draft({ cc: '', bcc: '' }));
    expect(response.status).toBe(200);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).not.toMatch(/SET[^;]*cc_addresses = \?/);
    expect(sql.calls[0].text).toContain("to_jsonb(drafts) ->> 'cc_addresses'");
  });
});

describe('updateDraft version check', () => {
  const SAVED_AT = '2026-10-02T10:00:00.123Z';

  test('without expectedUpdatedAt the write is unconditional, as before', async () => {
    const sql = createMockSql([[{ id: DRAFT_ID, updatedAt: SAVED_AT, attachmentIds: [] }]]);
    const response = await updateDraft(sql, USER_ID, DRAFT_ID, draft());
    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toMatch(/\?::timestamptz IS NULL/);
    expect(sql.calls).toHaveLength(1);
  });

  test('writes when the client saw the stored version, compared as a timestamp', async () => {
    const sql = createMockSql([
      [{ id: DRAFT_ID, updatedAt: '2026-10-02T10:00:05.000Z', attachmentIds: [] }],
    ]);
    const response = await updateDraft(
      sql,
      USER_ID,
      DRAFT_ID,
      // Same instant with an offset and microseconds: normalised before SQL.
      draft({ expectedUpdatedAt: '2026-10-02T12:00:00.123456+02:00' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      draft: { id: DRAFT_ID, updatedAt: '2026-10-02T10:00:05.000Z' },
    });
    expect(sql.calls[0].text).toMatch(/date_trunc\('milliseconds', updated_at\) = \?::timestamptz/);
    expect(sql.calls[0].values).toContain(SAVED_AT);
  });

  test('409s with the current draft, without writing, when it changed elsewhere', async () => {
    const current = { id: DRAFT_ID, to: 'a@b.com', subject: 'Theirs', updatedAt: SAVED_AT };
    const sql = createMockSql([
      [], // conditional UPDATE matched nothing
      [current], // current draft, GET shape
    ]);
    const response = await updateDraft(
      sql,
      USER_ID,
      DRAFT_ID,
      draft({ expectedUpdatedAt: '2026-10-02T09:59:00.000Z', attachmentIds: [ATTACHMENT_ID] }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Draft changed elsewhere', draft: current });
    expect(sql.calls[1].text).toMatch(/jsonb_agg/);
    expect(sql.calls.some((call) => /INSERT INTO draft_attachments/.test(call.text))).toBe(false);
    expect(sql.calls.some((call) => /DELETE FROM draft_attachments/.test(call.text))).toBe(false);
  });

  test('404s when the draft is gone rather than changed', async () => {
    const sql = createMockSql([[], []]);
    const response = await updateDraft(
      sql,
      USER_ID,
      DRAFT_ID,
      draft({ expectedUpdatedAt: SAVED_AT }),
    );
    expect(response.status).toBe(404);
  });

  test('a stale tab clearing its composer does not discard newer content', async () => {
    const current = { id: DRAFT_ID, subject: 'Newer', updatedAt: SAVED_AT };
    const sql = createMockSql([[], [current]]);
    const response = await updateDraft(sql, USER_ID, DRAFT_ID, {
      to: '',
      subject: '',
      text: '',
      expectedUpdatedAt: '2026-10-02T09:59:00.000Z',
    });
    expect(response.status).toBe(409);
    expect(sql.calls[0].text).toMatch(/DELETE FROM drafts[\s\S]*date_trunc/);
  });

  test('rejects an expectedUpdatedAt that is not a timestamp', async () => {
    const sql = createMockSql();
    const response = await updateDraft(
      sql,
      USER_ID,
      DRAFT_ID,
      draft({ expectedUpdatedAt: 'yesterday-ish' }),
    );
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('deleteDraft', () => {
  test('removes a sent or discarded draft', async () => {
    const sql = createMockSql([[{ id: DRAFT_ID }]]);
    expect((await deleteDraft(sql, USER_ID, DRAFT_ID)).status).toBe(204);
  });

  test('rejects a malformed id without querying', async () => {
    const sql = createMockSql();
    expect((await deleteDraft(sql, USER_ID, 'nope')).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('listDrafts', () => {
  test('returns metadata only, never a blob url', async () => {
    const sql = createMockSql([
      [
        {
          id: DRAFT_ID,
          to: 'a@b.com',
          subject: 'Hi',
          attachments: [{ id: ATTACHMENT_ID, filename: 'plan.pdf', source: 'upload' }],
        },
      ],
    ]);
    const response = await listDrafts(sql, USER_ID);
    const body = await response.json();
    expect(body.drafts).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('blob_url');
    expect(sql.calls[0].text).toMatch(/ORDER BY d.updated_at DESC/);
  });

  test('always returns bounded summaries, never full bodies', async () => {
    const sql = createMockSql([[]]);
    await listDrafts(sql, USER_ID);
    expect(sql.calls[0].text).toMatch(/LIMIT/);
    expect(sql.calls[0].text).not.toMatch(/body_html/);
  });
});

describe('setDraftStar', () => {
  test('stars the owner’s draft without touching its version', async () => {
    const sql = createMockSql([[{ id: DRAFT_ID, isStarred: true }]]);
    const response = await setDraftStar(sql, USER_ID, DRAFT_ID, { starred: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ draft: { id: DRAFT_ID, isStarred: true } });
    expect(sql.calls[0].text).toContain('SET is_starred = ?');
    expect(sql.calls[0].text).not.toContain('updated_at');
    expect(sql.calls[0].values).toEqual([true, true, DRAFT_ID, USER_ID]);
  });

  test('is not found for a draft the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await setDraftStar(sql, USER_ID, DRAFT_ID, { starred: false });
    expect(response.status).toBe(404);
  });

  test.each([undefined, {}, { starred: 'true' }, { starred: 1 }])(
    'refuses %j without querying',
    async (body) => {
      const sql = createMockSql();
      const response = await setDraftStar(sql, USER_ID, DRAFT_ID, body);
      expect(response.status).toBe(400);
      expect(sql.calls).toHaveLength(0);
    },
  );

  test('refuses an id that is not one', async () => {
    const sql = createMockSql();
    const response = await setDraftStar(sql, USER_ID, 'nope', { starred: true });
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
});
