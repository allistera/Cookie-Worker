import { describe, expect, it, vi } from 'vitest';
import {
  MAX_BLOCKS_BYTES,
  cleanText,
  createDocument,
  deleteDocument,
  getDocuments,
  normalizeBlocks,
  updateDocument,
} from '../src/documents.js';
import { createMockSql } from './helpers.js';

const USER_ID = '55555555-5555-4555-8555-555555555555';
const DOC_ID = '33333333-3333-4333-8333-333333333333';
const FOLDER_ID = '44444444-4444-4444-8444-444444444444';
const TEMPLATE_ID = '66666666-6666-4666-8666-666666666666';

/** @param {Partial<import('../src/documents.js').DocumentsDeps>} [overrides] */
function deps(overrides = {}) {
  return {
    openaiApiKey: undefined,
    allowRequest: vi.fn(async () => false),
    embedText: vi.fn(async () => {
      throw new Error('embedText should not be called when allowRequest denies');
    }),
    embedTextCached: vi.fn(async () => {
      throw new Error('embedTextCached should not be called in these tests');
    }),
    ...overrides,
  };
}

/** @param {string} [query] */
function url(query = '') {
  return new URL(`https://cookie-web-tasks.example/documents${query}`);
}

describe('GET /documents', () => {
  it("returns the caller's folders and documents together", async () => {
    const sql = createMockSql([
      [{ id: FOLDER_ID, parent_id: null, title: 'Projects', emoji: '📁' }],
      [{ id: DOC_ID, folder_id: FOLDER_ID, title: 'Notes', starred: false }],
    ]);
    const response = await getDocuments(sql, USER_ID, url(), deps());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.folders).toHaveLength(1);
    expect(body.documents).toHaveLength(1);
    expect(sql.calls[0].text).toContain('f.user_id =');
    expect(sql.calls[1].text).toContain('d.user_id =');
  });

  it('returns a single document with blocks when an id is given', async () => {
    const sql = createMockSql([[{ id: DOC_ID, title: 'Notes', blocks: [{ type: 'paragraph' }] }]]);
    const response = await getDocuments(sql, USER_ID, url(`?id=${DOC_ID}`), deps());

    expect(response.status).toBe(200);
    expect((await response.json()).document.blocks).toEqual([{ type: 'paragraph' }]);
    expect(sql.calls[0].text).toContain('d.blocks');
  });

  it('rejects a non-uuid id without touching the database', async () => {
    const sql = createMockSql();
    const response = await getDocuments(sql, USER_ID, url('?id=not-a-uuid'), deps());
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('404s a document the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await getDocuments(sql, USER_ID, url(`?id=${DOC_ID}`), deps());
    expect(response.status).toBe(404);
  });

  it('lists template metadata without loading blocks', async () => {
    const sql = createMockSql([[{ id: TEMPLATE_ID, title: 'Meeting notes', emoji: '📄' }]]);
    const response = await getDocuments(sql, USER_ID, url('?templates'), deps());

    expect(response.status).toBe(200);
    expect((await response.json()).templates[0].title).toBe('Meeting notes');
    expect(sql.calls[0].text).not.toContain('t.blocks');
  });

  it('returns one owned template with its blocks', async () => {
    const sql = createMockSql([
      [{ id: TEMPLATE_ID, title: 'Meeting notes', blocks: [{ type: 'header' }] }],
    ]);
    const response = await getDocuments(sql, USER_ID, url(`?templateId=${TEMPLATE_ID}`), deps());

    expect(response.status).toBe(200);
    expect((await response.json()).template.blocks).toEqual([{ type: 'header' }]);
    expect(sql.calls[0].text).toContain('t.blocks');
  });
});

// keywordLeg/recencyLeg/vectorLeg (documentRetrieval.js) compose nested sql
// fragments; this file's createMockSql executes every array-tagged call as a
// real, queue-consuming query and has no concept of a fragment nested inside
// another template, so it can't fake those legs' output. Covered instead at
// the SQL-building level in documentRetrieval.test.js. Only the guard
// clauses that return before any leg runs are covered here.
describe('GET /documents?q=… (search)', () => {
  it('429s when the shared ai quota is exhausted', async () => {
    const sql = createMockSql();
    const response = await getDocuments(
      sql,
      USER_ID,
      url('?q=roadmap'),
      deps({ openaiApiKey: 'sk-test' }),
    );
    expect(response.status).toBe(429);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects an oversized query', async () => {
    const sql = createMockSql();
    const response = await getDocuments(sql, USER_ID, url(`?q=${'x'.repeat(501)}`), deps());
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns no documents without touching the database when the query has no text or filters', async () => {
    const sql = createMockSql();
    // tag:"" carries an empty quoted operator value, so it is stripped to
    // blank free text and sets no filter — the query has nothing left to
    // search.
    const response = await getDocuments(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('tag:""')}`),
      deps(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documents: [] });
    expect(sql).not.toHaveBeenCalled();
  });

  it('treats an unrecognized operator value as free text rather than a filter', async () => {
    const sql = createMockSql();
    const response = await getDocuments(sql, USER_ID, url('?q=is:archived&mode=keyword'), deps());
    // 'is:archived' isn't a recognized is: value, so it stays in spec.text
    // and the keyword leg actually runs, rather than short-circuiting to an
    // empty result set the way an empty query does.
    expect(response.status).toBe(200);
    expect(sql).toHaveBeenCalled();
  });
});

describe('POST /documents', () => {
  it('creates a document in a folder the caller owns', async () => {
    const sql = createMockSql([
      [{ id: USER_ID }],
      [{ id: FOLDER_ID }],
      [{ id: DOC_ID, folder_id: FOLDER_ID, title: '', blocks: [] }],
    ]);
    const response = await createDocument(
      sql,
      USER_ID,
      { kind: 'document', folderId: FOLDER_ID },
      deps(),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).document.id).toBe(DOC_ID);
    expect(sql.calls[2].text).toContain('INSERT INTO documents');
  });

  it('embeds a non-blank new document and writes content_text + embedding', async () => {
    const sql = createMockSql([
      [{ id: USER_ID }],
      [{ id: DOC_ID, folder_id: null, title: 'Roadmap', blocks: [] }],
    ]);
    const response = await createDocument(
      sql,
      USER_ID,
      { kind: 'document', title: 'Roadmap' },
      deps({
        openaiApiKey: 'sk-test',
        allowRequest: vi.fn(async () => true),
        embedText: vi.fn(async () => [0.1, 0.2]),
      }),
    );

    expect(response.status).toBe(201);
    expect(sql.calls[1].text).toContain('embedding');
    expect(sql.calls[1].text).toContain('::extensions.vector');
    expect(sql.calls[1].text).toContain('content_text');
  });

  it('skips embedding for a blank new document without calling allowRequest', async () => {
    const sql = createMockSql([
      [{ id: USER_ID }],
      [{ id: DOC_ID, folder_id: null, title: '', blocks: [] }],
    ]);
    const denyIfCalled = vi.fn(async () => {
      throw new Error('allowRequest should not be called for a blank document');
    });
    const response = await createDocument(
      sql,
      USER_ID,
      { kind: 'document', folderId: null },
      deps({ openaiApiKey: 'sk-test', allowRequest: denyIfCalled }),
    );

    expect(response.status).toBe(201);
    expect(denyIfCalled).not.toHaveBeenCalled();
    expect(sql.calls[1].text).not.toContain('embedding');
  });

  it('rejects a folderId the caller does not own', async () => {
    const sql = createMockSql([[{ id: USER_ID }], []]);
    const response = await createDocument(
      sql,
      USER_ID,
      { kind: 'document', folderId: FOLDER_ID },
      deps(),
    );

    expect(response.status).toBe(400);
    expect(sql.calls.some((/** @type {any} */ c) => c.text.includes('INSERT'))).toBe(false);
  });

  it('creates a nested folder', async () => {
    const sql = createMockSql([
      [{ id: USER_ID }],
      [{ id: FOLDER_ID }],
      [{ id: 'new-folder', parent_id: FOLDER_ID, title: 'Sprint Planning' }],
    ]);
    const response = await createDocument(
      sql,
      USER_ID,
      { kind: 'folder', title: 'Sprint Planning', parentId: FOLDER_ID },
      deps(),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).folder.title).toBe('Sprint Planning');
  });

  it('requires a folder title', async () => {
    const sql = createMockSql([[{ id: USER_ID }]]);
    const response = await createDocument(sql, USER_ID, { kind: 'folder', title: '   ' }, deps());
    expect(response.status).toBe(400);
  });

  it('rejects an unknown kind', async () => {
    const sql = createMockSql([[{ id: USER_ID }]]);
    const response = await createDocument(sql, USER_ID, { kind: 'widget' }, deps());
    expect(response.status).toBe(400);
  });

  it('creates a reusable document template', async () => {
    const sql = createMockSql([
      [{ id: USER_ID }],
      [{ id: TEMPLATE_ID, title: 'Meeting notes', blocks: [{ type: 'header' }] }],
    ]);
    const response = await createDocument(
      sql,
      USER_ID,
      {
        kind: 'template',
        title: 'Meeting notes',
        blocks: [{ type: 'header', data: { text: 'Agenda' } }],
      },
      deps(),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).template.id).toBe(TEMPLATE_ID);
    expect(sql.calls[1].text).toContain('INSERT INTO document_templates');
  });

  it('creates a document by copying an owned template', async () => {
    const sql = createMockSql([
      [{ id: USER_ID }],
      [{ id: TEMPLATE_ID, title: 'Meeting notes', emoji: '📄', blocks: [{ type: 'header' }] }],
      [{ id: DOC_ID, title: 'Meeting notes', emoji: '📄', blocks: [{ type: 'header' }] }],
    ]);
    const response = await createDocument(
      sql,
      USER_ID,
      { kind: 'document', templateId: TEMPLATE_ID },
      deps(),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).document.title).toBe('Meeting notes');
    expect(sql.calls[1].text).toContain('document_templates');
    expect(sql.calls[2].text).toContain('INSERT INTO documents');
  });

  it('rejects a template the caller does not own', async () => {
    const sql = createMockSql([[{ id: USER_ID }], []]);
    const response = await createDocument(
      sql,
      USER_ID,
      { kind: 'document', templateId: TEMPLATE_ID },
      deps(),
    );

    expect(response.status).toBe(400);
    expect(sql.calls.some((/** @type {any} */ c) => c.text.includes('INSERT INTO documents'))).toBe(
      false,
    );
  });
});

describe('PATCH /documents', () => {
  it('saves blocks through sql.json and bumps updated_at', async () => {
    const sql = createMockSql([
      [{ title: 'Notes', blocks: [] }],
      [{ folder_id: null, title: 'Notes', blocks: [] }],
      [{ id: DOC_ID, title: 'Notes', folder_id: null }],
    ]);
    const response = await updateDocument(
      sql,
      USER_ID,
      { id: DOC_ID, blocks: [{ type: 'paragraph', data: {} }] },
      deps(),
    );

    expect(response.status).toBe(200);
    expect(sql.calls[1].text).toContain('folder_id');
    expect(sql.calls[2].text).toBe('SET(blocks,content_text)');
    expect(sql.calls[3].text).toContain('updated_at = now()');
  });

  it('syncs a Daily note time-range line into a linked calendar event', async () => {
    const sql = createMockSql([
      [{ title: '14-08-26', blocks: [] }],
      [{ folder_id: FOLDER_ID, title: '14-08-26', blocks: [] }],
      [{ id: DOC_ID, title: '14-08-26', folder_id: FOLDER_ID }],
      [{ title: 'Daily' }],
      [{ id: 'cal-personal' }],
      [],
    ]);
    const response = await updateDocument(
      sql,
      USER_ID,
      {
        id: DOC_ID,
        blocks: [{ id: 'block-1', type: 'paragraph', data: { text: '10:00 - 11:00 - Team sync' } }],
      },
      deps(),
    );

    expect(response.status).toBe(200);
    expect(sql.calls).toHaveLength(7);
    expect(sql.calls[4].text).toContain('ancestry');
    expect(sql.calls[5].text).toContain('FROM calendars');
    expect(sql.calls[6].text).toContain('ON CONFLICT (source_document_id, source_block_id)');
  });

  it('syncs a time-range line inside a bulleted/checklist list item', async () => {
    const sql = createMockSql([
      [{ title: '14-08-26', blocks: [] }],
      [{ folder_id: FOLDER_ID, title: '14-08-26', blocks: [] }],
      [{ id: DOC_ID, title: '14-08-26', folder_id: FOLDER_ID }],
      [{ title: 'Daily' }],
      [{ id: 'cal-personal' }],
      [],
    ]);
    const response = await updateDocument(
      sql,
      USER_ID,
      {
        id: DOC_ID,
        blocks: [
          {
            id: 'list-1',
            type: 'list',
            data: {
              style: 'checklist',
              items: [
                { content: '09:00 - Standup', meta: { checked: false } },
                { content: 'Plain task, no time', meta: { checked: false } },
              ],
            },
          },
        ],
      },
      deps(),
    );

    expect(response.status).toBe(200);
    expect(sql.calls).toHaveLength(7);
    expect(sql.calls[6].text).toContain('ON CONFLICT (source_document_id, source_block_id)');
  });

  it("does not touch calendar_events for a non-Daily document's blocks", async () => {
    const sql = createMockSql([
      [{ title: 'Notes', blocks: [] }],
      [{ folder_id: FOLDER_ID, title: 'Notes', blocks: [] }],
      [{ id: DOC_ID, title: 'Notes', folder_id: FOLDER_ID }],
    ]);
    const response = await updateDocument(
      sql,
      USER_ID,
      {
        id: DOC_ID,
        blocks: [{ id: 'block-1', type: 'paragraph', data: { text: '10:00 - 11:00 - Team sync' } }],
      },
      deps(),
    );

    expect(response.status).toBe(200);
    expect(sql.calls).toHaveLength(4);
  });

  it('re-embeds and writes the new vector when the save is allowed', async () => {
    const sql = createMockSql([
      [{ title: 'Notes', blocks: [] }],
      [{ folder_id: null, title: 'Notes', blocks: [] }],
      [{ id: DOC_ID, title: 'Notes', folder_id: null }],
    ]);
    const response = await updateDocument(
      sql,
      USER_ID,
      { id: DOC_ID, blocks: [{ type: 'paragraph', data: { text: 'Ship it' } }] },
      deps({
        openaiApiKey: 'sk-test',
        allowRequest: vi.fn(async () => true),
        embedText: vi.fn(async () => [0.1, 0.2]),
      }),
    );

    expect(response.status).toBe(200);
    expect(sql.calls[3].text).toContain('embedding');
    expect(sql.calls[3].text).toContain('::extensions.vector');
  });

  it('fetches the current blocks to embed a title-only rename', async () => {
    const sql = createMockSql([
      [{ title: 'Old title', blocks: [{ type: 'paragraph', data: { text: 'Body text' } }] }],
      [{ id: DOC_ID, title: 'New title' }],
    ]);
    const response = await updateDocument(sql, USER_ID, { id: DOC_ID, title: 'New title' }, deps());

    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toContain('SELECT title, blocks');
    expect(sql.calls[1].text).toBe('SET(title,content_text)');
  });

  it('404s a title/blocks-touching patch for a document the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await updateDocument(sql, USER_ID, { id: DOC_ID, title: 'New title' }, deps());

    expect(response.status).toBe(404);
    expect(sql.calls).toHaveLength(1);
  });

  it('toggles starred', async () => {
    const sql = createMockSql([[{ id: DOC_ID, starred: true }]]);
    const response = await updateDocument(sql, USER_ID, { id: DOC_ID, starred: true }, deps());

    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toBe('SET(starred)');
  });

  it('compares the updatedAt guard at millisecond precision', async () => {
    const sql = createMockSql([[{ id: DOC_ID, starred: true }]]);
    const response = await updateDocument(
      sql,
      USER_ID,
      { id: DOC_ID, starred: true, updatedAt: '2026-08-28T12:58:25.526Z' },
      deps(),
    );

    expect(response.status).toBe(200);
    // updated_at is a microsecond-precision timestamptz, but a client can only
    // ever echo back the millisecond ISO string it was given. Raw equality
    // therefore conflicted on every save of a row whose stored microseconds
    // were not zero.
    const update = sql.calls.find((call) => call.text.includes('UPDATE documents'));
    expect(update.text).toContain("date_trunc('milliseconds', d.updated_at)");
    expect(update.text).not.toMatch(/d\.updated_at\s*=\s*\?/);
  });

  it('409s a save whose updatedAt no longer matches the stored row', async () => {
    const sql = createMockSql([[], [{ exists: 1 }]]);
    const response = await updateDocument(
      sql,
      USER_ID,
      { id: DOC_ID, starred: true, updatedAt: '2026-08-28T12:58:25.526Z' },
      deps(),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('updated elsewhere');
  });

  it('moves a document to the root with folderId null', async () => {
    const sql = createMockSql([[{ id: DOC_ID, folder_id: null }]]);
    const response = await updateDocument(sql, USER_ID, { id: DOC_ID, folderId: null }, deps());

    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toBe('SET(folder_id)');
  });

  it('normalizes and saves document tags', async () => {
    const sql = createMockSql([[{ id: DOC_ID, tags: ['project-one', 'home'] }]]);
    const response = await updateDocument(
      sql,
      USER_ID,
      { id: DOC_ID, tags: ['#Project-One', 'home', 'HOME'] },
      deps(),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).document.tags).toEqual(['project-one', 'home']);
    expect(sql.calls[0].text).toBe('SET(tags)');
  });

  it('rejects invalid document tags', async () => {
    const sql = createMockSql();
    const response = await updateDocument(
      sql,
      USER_ID,
      { id: DOC_ID, tags: ['two words'] },
      deps(),
    );
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects non-array blocks', async () => {
    const sql = createMockSql();
    const response = await updateDocument(sql, USER_ID, { id: DOC_ID, blocks: 'nope' }, deps());
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects an empty update', async () => {
    const sql = createMockSql();
    const response = await updateDocument(sql, USER_ID, { id: DOC_ID }, deps());
    expect(response.status).toBe(400);
  });

  it('renames a folder', async () => {
    const sql = createMockSql([[{ id: FOLDER_ID, title: 'Renamed' }]]);
    const response = await updateDocument(
      sql,
      USER_ID,
      { kind: 'folder', id: FOLDER_ID, title: 'Renamed' },
      deps(),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).folder.title).toBe('Renamed');
  });

  it('404s a document the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await updateDocument(sql, USER_ID, { id: DOC_ID, title: 'Stolen' }, deps());
    expect(response.status).toBe(404);
  });

  it('updates an owned template title and blocks together', async () => {
    const sql = createMockSql([
      [{ id: TEMPLATE_ID, title: 'Weekly notes', blocks: [{ type: 'list' }] }],
    ]);
    const response = await updateDocument(
      sql,
      USER_ID,
      {
        kind: 'template',
        id: TEMPLATE_ID,
        title: 'Weekly notes',
        blocks: [{ type: 'list', data: { items: [] } }],
      },
      deps(),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).template.title).toBe('Weekly notes');
    expect(sql.calls[0].text).toContain('UPDATE document_templates');
  });

  it('rejects a non-uuid id', async () => {
    const sql = createMockSql();
    const response = await updateDocument(sql, USER_ID, { id: 'not-a-uuid', title: 'x' }, deps());
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('DELETE /documents', () => {
  it('deletes an owned document', async () => {
    const sql = createMockSql([[{ id: DOC_ID }]]);
    const response = await deleteDocument(sql, USER_ID, { kind: 'document', id: DOC_ID });

    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toContain('DELETE FROM documents');
  });

  it('deletes an owned folder', async () => {
    const sql = createMockSql([[{ id: FOLDER_ID }]]);
    const response = await deleteDocument(sql, USER_ID, { kind: 'folder', id: FOLDER_ID });

    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toContain('DELETE FROM document_folders');
  });

  it('404s an id the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await deleteDocument(sql, USER_ID, { kind: 'document', id: DOC_ID });
    expect(response.status).toBe(404);
  });

  it('deletes an owned template', async () => {
    const sql = createMockSql([[{ id: TEMPLATE_ID }]]);
    const response = await deleteDocument(sql, USER_ID, { kind: 'template', id: TEMPLATE_ID });

    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toContain('DELETE FROM document_templates');
  });

  it('rejects a non-uuid id without touching the database', async () => {
    const sql = createMockSql();
    const response = await deleteDocument(sql, USER_ID, { id: 'not-a-uuid' });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('normalizeBlocks', () => {
  it('accepts an array of objects', () => {
    expect(normalizeBlocks([{ type: 'paragraph' }])).toEqual([{ type: 'paragraph' }]);
  });

  it('rejects non-arrays and arrays holding non-objects', () => {
    expect(normalizeBlocks('nope')).toBeNull();
    expect(normalizeBlocks([{ ok: 1 }, 'nope'])).toBeNull();
    expect(normalizeBlocks([null])).toBeNull();
  });

  it('rejects a payload over the size cap', () => {
    const oversized = [{ type: 'image', data: { url: 'x'.repeat(MAX_BLOCKS_BYTES) } }];
    expect(normalizeBlocks(oversized)).toBeNull();
  });
});

describe('cleanText', () => {
  it('trims and bounds strings, and rejects non-strings', () => {
    expect(cleanText('  hi  ', 10)).toBe('hi');
    expect(cleanText('abcdef', 3)).toBe('abc');
    expect(cleanText(42, 10)).toBeNull();
  });
});
