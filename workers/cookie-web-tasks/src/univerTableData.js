// Ported from Cookie-Web's src/lib/univerTableData.js — only
// flattenWorkbookCellText, the piece documentText.js's search-flattening
// needs. contentGridToWorkbookData (legacy-content-grid -> Univer snapshot
// conversion) is a client/migration-script concern, not used server-side
// here. Pure JS, no Node APIs.

/**
 * Best-effort plain text out of a Univer workbook snapshot's cell values, in
 * reading order, for search indexing. Rich text cells (`p`) and anything
 * else beyond a plain `v`/`f` are skipped rather than guessed at.
 *
 * @param {any} workbook
 */
export function flattenWorkbookCellText(workbook) {
  const sheets = workbook?.sheets ?? {};
  const sheetIds = Array.isArray(workbook?.sheetOrder) ? workbook.sheetOrder : Object.keys(sheets);

  /** @type {string[]} */
  const lines = [];
  for (const sheetId of sheetIds) {
    const cellData = sheets[sheetId]?.cellData ?? {};
    for (const row of Object.values(cellData)) {
      for (const cell of Object.values(/** @type {any} */ (row) ?? {})) {
        const text = String(/** @type {any} */ (cell)?.v ?? '').trim();
        if (text) lines.push(text);
      }
    }
  }
  return lines;
}
