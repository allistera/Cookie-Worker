import { describe, expect, test, vi } from 'vitest';
import { getDocumentMetadata, getDocumentPage } from '../src/documentPages.js';
import { encodeCursor, decodeCursor } from '../../../shared/pagination.js';
import { createMockSql } from './helpers.js';

const owner = 'owner';
const id = '11111111-1111-4111-8111-111111111111';
const time = '2026-10-21T12:00:00.123456Z';
const url = (query = '') => new URL(`https://example.test/documents${query}`);

describe('document navigation metadata', () => {
  test('returns global folders, tags and counts from one consistent snapshot', async () => {
    const folders = [{ id, title: 'Work' }];
    const tags = [{ name: 'work', count: 150 }];
    const counts = { total: 200, starred: 12 };
    const sql = createMockSql([[], [{ revision: '7' }], folders, tags, [counts]]);
    const response = await getDocumentMetadata(sql, owner, url());
    expect(await response.json()).toEqual({ folders, tags, counts, version: '7' });
    expect(sql.begin).toHaveBeenCalledOnce();
    expect(sql.calls[0].text).toContain('REPEATABLE READ READ ONLY');
    for (const call of sql.calls.slice(1)) expect(call.values).toEqual([owner]);
  });

  test('skips metadata queries when the client revision matches', async () => {
    const sql = createMockSql([[], [{ revision: '7' }]]);
    const response = await getDocumentMetadata(sql, owner, url('?version=7'));
    expect(await response.json()).toEqual({ unchanged: true, version: '7' });
    expect(sql).toHaveBeenCalledTimes(2);
  });

  test('uses version zero when a workspace has no revision record', async () => {
    const sql = createMockSql([[], []]);
    const response = await getDocumentMetadata(sql, owner, url('?version=0'));
    expect(await response.json()).toEqual({ unchanged: true, version: '0' });
  });
});

/** @param {any[]} rows */
function pageSql(rows) {
  // Nested tagged templates are query fragments, not database round trips.
  /** @type {any} */
  const sql = vi.fn((strings, ...values) => {
    const text = strings.join('?');
    return text.includes('FROM documents') ? Promise.resolve(rows) : { text, values };
  });
  return sql;
}

describe('document pages', () => {
  test.each(['?folder=invalid', `?tag=${'x'.repeat(101)}`])(
    'rejects invalid filters before querying: %s',
    async (query) => {
      const sql = pageSql([]);
      const response = await getDocumentPage(sql, owner, url(query));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid document filter' });
      expect(sql).not.toHaveBeenCalled();
    },
  );

  test.each([
    'broken',
    encodeCursor({}),
    encodeCursor([]),
    encodeCursor(['invalid', id]),
    encodeCursor([time, 'invalid']),
  ])('rejects invalid cursor %s before querying', async (cursor) => {
    const sql = pageSql([]);
    const response = await getDocumentPage(sql, owner, url(`?before=${cursor}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid document cursor' });
    expect(sql).not.toHaveBeenCalled();
  });

  test('returns an empty terminal page without filters', async () => {
    const sql = pageSql([]);
    const response = await getDocumentPage(sql, owner, url());
    expect(await response.json()).toEqual({ documents: [], nextCursor: null });
    expect(sql.mock.calls.at(-1).slice(1)).toEqual([
      owner,
      ...Array.from({ length: 4 }, () => ({ text: '', values: [] })),
    ]);
  });

  test('applies folder, starred, tag and cursor filters together', async () => {
    const sql = pageSql([{ id, title: 'Notes', cursor_time: time }]);
    const response = await getDocumentPage(
      sql,
      owner,
      url(`?folder=${id}&starred=1&tag=work&before=${encodeCursor([time, id])}`),
    );
    expect(await response.json()).toEqual({
      documents: [{ id, title: 'Notes' }],
      nextCursor: null,
    });
    expect(sql.mock.calls.at(-1).slice(1)).toEqual([
      owner,
      { text: 'AND folder_id = ?::uuid', values: [id] },
      { text: 'AND starred', values: [] },
      { text: 'AND tags @> ARRAY[?]::text[]', values: ['work'] },
      { text: 'AND (updated_at, id) < (?::text::timestamptz, ?::uuid)', values: [time, id] },
    ]);
  });

  test.each([100, 101])(
    'returns at most 100 root documents and a cursor only when more exist (%i rows)',
    async (count) => {
      const rows = Array.from({ length: count }, (_, index) => ({
        id,
        title: `Document ${index}`,
        cursor_time: time,
      }));
      const sql = pageSql(rows);
      const response = await getDocumentPage(sql, owner, url('?folder=root'));
      const body = await response.json();
      expect(body.documents).toHaveLength(100);
      expect(body.documents.at(-1)).toEqual({ id, title: 'Document 99' });
      expect(sql.mock.calls.at(-1)[2]).toEqual({ text: 'AND folder_id IS NULL', values: [] });
      if (count === 101) expect(decodeCursor(body.nextCursor, () => true)).toEqual([time, id]);
      else expect(body.nextCursor).toBeNull();
    },
  );
});
