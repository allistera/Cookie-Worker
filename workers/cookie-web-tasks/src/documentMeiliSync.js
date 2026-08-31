import { DOCUMENTS_INDEX } from '../../../shared/meili/documents.js';
import {
  addDocuments as addDocumentsDefault,
  deleteDocuments as deleteDocumentsDefault,
  meiliAvailable,
} from '../../../shared/meili.js';

/**
 * Best-effort push of one document. Mirrors mail-app-ingest's syncMessageToMeili:
 * reads the authoritative row and pushes it, and never throws — a document save
 * must not fail because search indexing did. A miss is repaired by the drift
 * sweep, which is what search_indexed_at exists for.
 *
 * @param {import('postgres').Sql} sql
 * @param {any} env
 * @param {string} documentId
 * @param {{addDocuments?: Function}} [deps]
 */
export async function syncDocumentToMeili(sql, env, documentId, deps = {}) {
  if (!meiliAvailable(env)) return;
  const addDocs = deps.addDocuments ?? addDocumentsDefault;

  try {
    const [row] = await sql`
      SELECT d.id, d.user_id, d.title, d.content_text, d.tags, d.starred, d.updated_at
      FROM documents d
      WHERE d.id = ${documentId}
    `;
    if (!row) return;
    await addDocs(env, DOCUMENTS_INDEX, [row]);
    await sql`UPDATE documents SET search_indexed_at = now() WHERE id = ${documentId}`;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'document_meili_sync_failed',
        document_id: documentId,
        message: /** @type {Error} */ (error).message,
      }),
    );
  }
}

/**
 * @param {any} env
 * @param {string} documentId
 * @param {{deleteDocuments?: Function}} [deps]
 */
export async function removeDocumentFromMeili(env, documentId, deps = {}) {
  if (!meiliAvailable(env)) return;
  const removeDocs = deps.deleteDocuments ?? deleteDocumentsDefault;

  try {
    await removeDocs(env, DOCUMENTS_INDEX, [documentId]);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'document_meili_delete_failed',
        document_id: documentId,
        message: /** @type {Error} */ (error).message,
      }),
    );
  }
}
