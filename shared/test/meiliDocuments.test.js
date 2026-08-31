import { describe, expect, it } from 'vitest';

import { DOCUMENTS_INDEX } from '../meili/documents.js';

describe('documents index descriptor', () => {
  it('searches title, body and tags', () => {
    expect(DOCUMENTS_INDEX.searchable).toEqual(['title', 'content_text', 'tags']);
  });

  // user_id is the only thing separating one person's documents from another's
  // once retrieval leaves Postgres.
  it('can filter by user, tags, starred and updated_at', () => {
    expect(DOCUMENTS_INDEX.filterable).toEqual(['user_id', 'tags', 'starred', 'updated_at']);
  });

  it('sorts by updated_at, which replaces the recency leg', () => {
    expect(DOCUMENTS_INDEX.sortable).toEqual(['updated_at']);
  });

  it('embeds title and body but not tags', () => {
    expect(DOCUMENTS_INDEX.embedder.documentTemplate).toContain('doc.title');
    expect(DOCUMENTS_INDEX.embedder.documentTemplate).toContain('doc.content_text');
    expect(DOCUMENTS_INDEX.embedder.documentTemplate).not.toContain('doc.tags');
  });

  it('maps a row to a document', () => {
    const doc = DOCUMENTS_INDEX.toDocument({
      id: 'd1',
      user_id: 'u1',
      title: 'Roof plan',
      content_text: 'tiles and gutters',
      tags: ['home'],
      starred: true,
      updated_at: '2026-08-31T10:00:00Z',
    });

    expect(doc).toEqual({
      id: 'd1',
      user_id: 'u1',
      title: 'Roof plan',
      content_text: 'tiles and gutters',
      tags: ['home'],
      starred: true,
      updated_at: new Date('2026-08-31T10:00:00Z').getTime(),
    });
  });

  // Meilisearch sorts and filters numbers, not ISO strings.
  it('stores updated_at as a number', () => {
    const doc = DOCUMENTS_INDEX.toDocument({ id: 'd1', updated_at: '2026-08-31T10:00:00Z' });
    expect(typeof doc.updated_at).toBe('number');
  });

  it('tolerates a document with no title, body or tags', () => {
    const doc = DOCUMENTS_INDEX.toDocument({ id: 'd1', user_id: 'u1' });
    expect(doc).toMatchObject({ title: '', content_text: '', tags: [], starred: false });
  });
});
