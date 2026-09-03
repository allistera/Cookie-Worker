import { describe, expect, test } from 'vitest';
import {
  createDraft,
  deleteDraft,
  isEmptyDraft,
  listDrafts,
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
  ])('refuses a draft the send API would later reject: %s', (overrides, _label) => {
    expect(parseDraftBody(draft(overrides))).toBeNull();
  });
});

describe('isEmptyDraft', () => {
  test('treats whitespace-only content as empty', () => {
    expect(isEmptyDraft(accepted({ to: ' ', subject: '', text: '  \n ' }))).toBe(true);
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
});

describe('updateDraft', () => {
  test('replaces the whole draft rather than merging fields', async () => {
    const sql = createMockSql([[{ id: DRAFT_ID, updatedAt: 'now' }], [], []]);
    const response = await updateDraft(sql, USER_ID, DRAFT_ID, draft({ subject: 'Changed' }));
    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toMatch(/UPDATE drafts/);
    expect(sql.calls[0].values).toContain('Changed');
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
    expect(inserts[0].values).toContain(ATTACHMENT_ID);
    expect(inserts[0].values).not.toContain(foreignId);
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
});
