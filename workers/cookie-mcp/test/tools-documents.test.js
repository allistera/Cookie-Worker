import { describe, expect, test } from 'vitest';
import { ToolInputError } from '../src/results.js';
import { tools } from '../src/tools/documents.js';
import { byName, fakeApi } from './helpers.js';

const DOC = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';

/** @param {string} name @param {any} args @param {any} api */
async function call(name, args, api) {
  const tool = byName(tools, name);
  const result = await tool.run(tool.inputSchema.parse(args), api);
  tool.outputSchema.parse(result);
  return result;
}

const row = {
  id: DOC,
  folder_id: null,
  title: 'Notes',
  emoji: null,
  starred: false,
  tags: [],
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-02T00:00:00.000Z',
};
const blocks = [{ type: 'paragraph', data: { text: 'Hello &amp; bye' } }];

describe('documents tools', () => {
  test('cookie_list_documents first page also returns folders and tags', async () => {
    const api = fakeApi();
    const folders = [
      { id: FOLDER, parent_id: null, title: 'Work', emoji: null, created_at: '2026-10-01' },
    ];
    const tags = [{ name: 'a', count: 2 }];
    api.tasks.get.mockImplementation(async (_path, query) =>
      query.view === 'meta'
        ? { folders, tags, counts: { total: 1, starred: 0 }, version: 'v1' }
        : { documents: [row], nextCursor: null },
    );
    const result = await call('cookie_list_documents', {}, api);
    expect(api.tasks.get).toHaveBeenCalledWith('/documents', {
      view: 'page',
      folder: undefined,
      starred: undefined,
      tag: undefined,
      before: undefined,
    });
    expect(api.tasks.get).toHaveBeenCalledWith('/documents', { view: 'meta' });
    expect(result).toEqual({ documents: [row], nextCursor: null, folders, tags });
  });

  test('cookie_list_documents with a cursor skips meta and passes filters', async () => {
    const api = fakeApi();
    api.tasks.get.mockResolvedValue({ documents: [], nextCursor: null });
    const result = await call(
      'cookie_list_documents',
      { folder: 'root', starred: true, tag: 'x', cursor: 'c1' },
      api,
    );
    expect(api.tasks.get).toHaveBeenCalledTimes(1);
    expect(api.tasks.get).toHaveBeenCalledWith('/documents', {
      view: 'page',
      folder: 'root',
      starred: '1',
      tag: 'x',
      before: 'c1',
    });
    expect(result).toEqual({ documents: [], nextCursor: null });
  });

  test('cookie_search_documents defaults to hybrid and maps keyword mode', async () => {
    const api = fakeApi();
    api.tasks.get.mockResolvedValue({ documents: [row] });
    expect(await call('cookie_search_documents', { query: 'tag:a rent' }, api)).toEqual({
      documents: [row],
    });
    expect(api.tasks.get).toHaveBeenLastCalledWith('/documents', {
      q: 'tag:a rent',
      mode: undefined,
    });
    await call('cookie_search_documents', { query: 'rent', mode: 'keyword' }, api);
    expect(api.tasks.get).toHaveBeenLastCalledWith('/documents', { q: 'rent', mode: 'keyword' });
  });

  test('cookie_get_document returns text, and blocks only on request', async () => {
    const api = fakeApi();
    api.tasks.get.mockResolvedValue({ document: { ...row, blocks } });
    const plain = await call('cookie_get_document', { id: DOC }, api);
    expect(api.tasks.get).toHaveBeenCalledWith('/documents', { id: DOC });
    expect(plain).toEqual({
      id: DOC,
      title: 'Notes',
      folderId: null,
      tags: [],
      starred: false,
      updatedAt: row.updated_at,
      text: 'Hello & bye',
      truncated: false,
    });
    const rich = await call('cookie_get_document', { id: DOC, includeBlocks: true }, api);
    expect(rich.blocks).toEqual(blocks);
  });

  test('cookie_get_document truncates long text', async () => {
    const api = fakeApi();
    api.tasks.get.mockResolvedValue({
      document: { ...row, blocks: [{ type: 'paragraph', data: { text: 'x'.repeat(30_000) } }] },
    });
    const result = await call('cookie_get_document', { id: DOC }, api);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(20_000);
  });

  test('cookie_create_document with no content only posts', async () => {
    const api = fakeApi();
    api.tasks.post.mockResolvedValue({ document: { ...row, blocks: [] } });
    const result = await call('cookie_create_document', { title: 'Notes' }, api);
    expect(api.tasks.post).toHaveBeenCalledWith('/documents', { kind: 'document', title: 'Notes' });
    expect(api.tasks.patch).not.toHaveBeenCalled();
    expect(result).toEqual({
      document: { id: DOC, title: 'Notes', folderId: null, updatedAt: row.updated_at },
    });
  });

  test('cookie_create_document writes text with a follow-up patch', async () => {
    const api = fakeApi();
    api.tasks.post.mockResolvedValue({ document: { ...row, folder_id: FOLDER, blocks: [] } });
    api.tasks.patch.mockResolvedValue({
      document: { ...row, folder_id: FOLDER, updated_at: '2026-10-03T00:00:00.000Z' },
    });
    const result = await call(
      'cookie_create_document',
      { folderId: FOLDER, templateId: TEMPLATE, text: '# Hi\n\n- a' },
      api,
    );
    expect(api.tasks.post).toHaveBeenCalledWith('/documents', {
      kind: 'document',
      folderId: FOLDER,
      templateId: TEMPLATE,
    });
    expect(api.tasks.patch).toHaveBeenCalledWith('/documents', {
      id: DOC,
      blocks: [
        { type: 'header', data: { text: 'Hi', level: 1 } },
        {
          type: 'list',
          data: { style: 'unordered', items: [{ content: 'a', items: [] }] },
        },
      ],
    });
    expect(result.document).toEqual({
      id: DOC,
      title: 'Notes',
      folderId: FOLDER,
      updatedAt: '2026-10-03T00:00:00.000Z',
    });
  });

  test('cookie_create_document passes explicit blocks and rejects text plus blocks', async () => {
    const api = fakeApi();
    api.tasks.post.mockResolvedValue({ document: { ...row, blocks: [] } });
    api.tasks.patch.mockResolvedValue({ document: row });
    await call('cookie_create_document', { blocks }, api);
    expect(api.tasks.patch).toHaveBeenCalledWith('/documents', { id: DOC, blocks });
    const tool = byName(tools, 'cookie_create_document');
    await expect(
      tool.run(tool.inputSchema.parse({ text: 'a', blocks }), fakeApi()),
    ).rejects.toThrow(ToolInputError);
  });

  test('cookie_update_document sends only provided keys and maps names', async () => {
    const api = fakeApi();
    api.tasks.patch.mockResolvedValue({ document: row });
    const result = await call(
      'cookie_update_document',
      {
        id: DOC,
        title: 'New',
        text: 'body',
        tags: ['a'],
        starred: true,
        folderId: null,
        expectedUpdatedAt: row.updated_at,
      },
      api,
    );
    expect(api.tasks.patch).toHaveBeenCalledWith('/documents', {
      id: DOC,
      title: 'New',
      blocks: [{ type: 'paragraph', data: { text: 'body' } }],
      tags: ['a'],
      starred: true,
      folderId: null,
      updatedAt: row.updated_at,
    });
    expect(result).toEqual({ document: row });
  });

  test('cookie_update_document needs a change and rejects text plus blocks', async () => {
    const api = fakeApi();
    const tool = byName(tools, 'cookie_update_document');
    await expect(tool.run(tool.inputSchema.parse({ id: DOC }), api)).rejects.toThrow(
      ToolInputError,
    );
    await expect(
      tool.run(tool.inputSchema.parse({ id: DOC, text: 'a', blocks }), api),
    ).rejects.toThrow(ToolInputError);
    expect(api.tasks.patch).not.toHaveBeenCalled();
  });

  test('cookie_delete_document deletes by id', async () => {
    const api = fakeApi();
    api.tasks.delete.mockResolvedValue({ ok: true });
    const result = await call('cookie_delete_document', { id: DOC }, api);
    expect(api.tasks.delete).toHaveBeenCalledWith('/documents', { id: DOC });
    expect(result).toEqual({ deleted: true, id: DOC });
  });
});
