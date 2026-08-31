import { EMBEDDER } from './embedder.js';

/**
 * The documents index — id, user_id, title, tags, starred, updated_at, plus
 * content_text, the flattened body flattenBlocksToText already produces
 * (see toDocument below for the exact shape each attribute maps to).
 */
export const DOCUMENTS_INDEX = {
  name: 'documents',
  primaryKey: 'id',
  searchable: ['title', 'content_text', 'tags'],
  filterable: ['user_id', 'tags', 'starred', 'updated_at'],
  sortable: ['updated_at'],
  semanticRatio: 0.5,
  // Title and body only, matching what the app embedded. Tags stay searchable
  // but out of the vector so a tag never dilutes what a document is about.
  embedder: {
    ...EMBEDDER,
    documentTemplate: '{{doc.title}}\n\n{{doc.content_text}}',
  },
  toDocument: (row) => ({
    id: row.id,
    user_id: row.user_id,
    title: row.title ?? '',
    content_text: row.content_text ?? '',
    tags: row.tags ?? [],
    starred: Boolean(row.starred),
    // Numeric so Meilisearch can sort and filter on it.
    updated_at: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  }),
};
