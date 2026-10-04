import * as z from 'zod';
import { blocksToText, boundBlocks, textToBlocks } from '../blocks.js';
import { ToolInputError, truncateText } from '../results.js';
import { provided, READ_ONLY, UNTRUSTED } from './common.js';

const id = z.string().uuid();
const blocksInput = z
  .array(z.record(z.string(), z.unknown()))
  .describe('Editor.js blocks; use includeBlocks on cookie_get_document to see the format');

// Rows come straight from the API: nullable columns stay nullable and extra fields pass.
const rows = z.array(z.record(z.string(), z.unknown()));

/**
 * Converts the write body's text or blocks to Editor.js blocks; undefined when neither given.
 * @param {{text?: string, blocks?: Record<string, unknown>[]}} args
 */
function contentBlocks({ text, blocks }) {
  if (text !== undefined && blocks !== undefined) {
    throw new ToolInputError('Pass either text or blocks, not both');
  }
  return text !== undefined ? textToBlocks(text) : blocks;
}

/** @type {import('./types.js').ToolDefinition[]} */
export const tools = [
  {
    name: 'cookie_list_documents',
    title: 'List documents',
    description:
      'Lists documents (id, title, folder, tags, starred, timestamps; no body) one page at a time, ' +
      'newest first. The first page also returns the folder tree and tag counts. ' +
      UNTRUSTED,
    inputSchema: z.object({
      folder: z.string().optional().describe('Folder id, or "root" for documents outside folders'),
      starred: z.boolean().default(false),
      tag: z.string().max(100).optional(),
      cursor: z.string().optional().describe('nextCursor from a previous page'),
    }),
    outputSchema: z.object({
      documents: rows,
      nextCursor: z.string().nullable(),
      folders: rows.optional(),
      tags: rows.optional(),
    }),
    annotations: READ_ONLY,
    async run({ folder, starred, tag, cursor }, api) {
      const [page, meta] = await Promise.all([
        api.tasks.get('/documents', {
          view: 'page',
          folder,
          starred: starred ? '1' : undefined,
          tag,
          before: cursor,
        }),
        cursor ? undefined : api.tasks.get('/documents', { view: 'meta' }),
      ]);
      return {
        documents: page.documents ?? [],
        nextCursor: page.nextCursor ?? null,
        ...(meta ? { folders: meta.folders ?? [], tags: meta.tags ?? [] } : {}),
      };
    },
  },
  {
    name: 'cookie_search_documents',
    title: 'Search documents',
    description:
      'Searches documents by meaning and keywords (up to 20 results, no paging). ' +
      'The query supports `tag:<name>` and `is:starred`. ' +
      UNTRUSTED,
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      mode: z.enum(['hybrid', 'keyword']).default('hybrid'),
    }),
    outputSchema: z.object({ documents: rows }),
    annotations: READ_ONLY,
    async run({ query, mode }, api) {
      const body = await api.tasks.get('/documents', {
        q: query,
        mode: mode === 'keyword' ? 'keyword' : undefined,
      });
      return { documents: body.documents ?? [] };
    },
  },
  {
    name: 'cookie_get_document',
    title: 'Get a document',
    description:
      `Reads one document as plain text (headings as #, bullets as -). ${UNTRUSTED} ` +
      'Set includeBlocks to also get the raw Editor.js blocks for precise edits. If blocksLossy is ' +
      'true, embedded data was left out or the blocks were too large to return: do not send those ' +
      'blocks back to cookie_update_document, or the omitted content is lost.',
    inputSchema: z.object({ id, includeBlocks: z.boolean().default(false) }),
    outputSchema: z.object({
      id: z.string(),
      title: z.string().nullable(),
      folderId: z.string().nullable(),
      tags: z.array(z.string()),
      starred: z.boolean(),
      updatedAt: z.string(),
      text: z.string(),
      truncated: z.boolean(),
      blocks: z.array(z.unknown()).optional(),
      blocksLossy: z.boolean().optional(),
    }),
    annotations: READ_ONLY,
    async run({ id: documentId, includeBlocks }, api) {
      const { document } = await api.tasks.get('/documents', { id: documentId });
      const { text, truncated } = truncateText(blocksToText(document.blocks));
      return {
        id: document.id,
        title: document.title,
        folderId: document.folder_id,
        tags: document.tags,
        starred: document.starred,
        updatedAt: document.updated_at,
        text,
        truncated,
        ...(includeBlocks ? boundBlocks(document.blocks ?? []) : {}),
      };
    },
  },
  {
    name: 'cookie_create_document',
    title: 'Create a document',
    description:
      'Creates a document, optionally from a template and with initial content. `text` accepts ' +
      'plain text with `#` headings and `- ` bullets; pass `blocks` instead for rich content. ' +
      'Content is written in a second step; if that write fails the new document is removed.',
    inputSchema: z.object({
      title: z.string().max(300).optional(),
      folderId: id.nullable().optional(),
      templateId: id.optional(),
      text: z.string().optional(),
      blocks: blocksInput.optional(),
    }),
    outputSchema: z.object({
      document: z.object({
        id: z.string(),
        title: z.string().nullable(),
        folderId: z.string().nullable(),
        updatedAt: z.string(),
      }),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run({ title, folderId, templateId, text, blocks }, api) {
      const content = contentBlocks({ text, blocks });
      const body = provided({ kind: 'document', title, folderId, templateId });
      const created = await api.tasks.post('/documents', body);
      // The create route ignores blocks, so content is written with a follow-up patch.
      let document = created.document;
      if (content !== undefined) {
        try {
          ({ document } = await api.tasks.patch('/documents', {
            id: created.document.id,
            blocks: content,
          }));
        } catch (error) {
          // Do not leave a blank document behind for a retry to duplicate.
          try {
            await api.tasks.delete('/documents', { id: created.document.id });
          } catch {
            throw new ToolInputError(
              'Document was created but its content could not be written; update or delete document ' +
                created.document.id,
            );
          }
          throw error;
        }
      }
      return {
        document: {
          id: document.id,
          title: document.title,
          folderId: document.folder_id,
          updatedAt: document.updated_at,
        },
      };
    },
  },
  {
    name: 'cookie_update_document',
    title: 'Update a document',
    description:
      'Changes only the fields you pass. `text` (plain text with `#` headings and `- ` bullets) or ' +
      '`blocks` replaces the whole body; use includeBlocks + blocks to edit rich content precisely. ' +
      'Pass expectedUpdatedAt from cookie_get_document to avoid overwriting concurrent edits.',
    inputSchema: z.object({
      id,
      title: z.string().max(300).optional(),
      text: z.string().optional(),
      blocks: blocksInput.optional(),
      tags: z.array(z.string().min(1).max(100)).max(20).optional(),
      starred: z.boolean().optional(),
      folderId: id.nullable().optional().describe('Target folder id; null moves it out of folders'),
      expectedUpdatedAt: z.string().min(1).optional().describe('updatedAt you last read'),
    }),
    outputSchema: z.object({ document: z.record(z.string(), z.unknown()) }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(
      { id: documentId, title, text, blocks, tags, starred, folderId, expectedUpdatedAt },
      api,
    ) {
      const changes = provided({
        title,
        blocks: contentBlocks({ text, blocks }),
        tags,
        starred,
        folderId,
      });
      if (Object.keys(changes).length === 0) {
        throw new ToolInputError('Pass at least one field to change');
      }
      const body = await api.tasks.patch('/documents', {
        id: documentId,
        ...changes,
        ...(expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}),
      });
      return { document: body.document };
    },
  },
  {
    name: 'cookie_delete_document',
    title: 'Delete a document',
    description: 'Permanently deletes a document and its content. This cannot be undone.',
    inputSchema: z.object({ id }),
    outputSchema: z.object({ deleted: z.literal(true), id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run({ id: documentId }, api) {
      await api.tasks.delete('/documents', { id: documentId });
      return { deleted: true, id: documentId };
    },
  },
];
