// Ported verbatim from Cookie-Web's api/_lib/documentText.js — pure JS, no
// Node APIs.
//
// Flattens a document's title + Editor.js blocks into plain text for
// search: the generated tsvector column and the embedding input both read
// from content_text, computed by flattenBlocksToText and written alongside
// every title/blocks save.

import { flattenWorkbookCellText } from './univerTableData.js';

// Editor.js paragraph/header/list-item text is HTML (inline bold/italic/link
// markup from the toolbar) — strip tags so formatting can't leak into search
// text. Local copy of dailyEventSync.js's identical helper: entangling two
// unrelated modules through a 6-line string utility isn't worth the coupling.
/** @param {any} html */
function plainText(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** @param {string[]} lines @param {string} text */
function pushIf(lines, text) {
  if (text) lines.push(text);
}

// @editorjs/list nests items arbitrarily deep via item.items; each item's own
// text lives in item.content.
const MAX_LIST_DEPTH = 16;

/** @param {any[]} items @param {string[]} lines @param {number} [depth] */
function listItemLines(items, lines, depth = 0) {
  if (depth > MAX_LIST_DEPTH) return;
  for (const item of items ?? []) {
    pushIf(lines, plainText(item?.content));
    if (Array.isArray(item?.items) && item.items.length > 0) {
      listItemLines(item.items, lines, depth + 1);
    }
  }
}

// Blocks with no representable text (delimiter, date, excalidraw, and any
// unrecognized future block type) are silently skipped rather than throwing,
// so an unfamiliar block never breaks a save.
/**
 * @param {any} title
 * @param {any[] | null | undefined} blocks
 */
export function flattenBlocksToText(title, blocks) {
  const lines = [plainText(title)];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    switch (block?.type) {
      case 'header':
      case 'paragraph':
        pushIf(lines, plainText(block.data?.text));
        break;
      case 'list':
        listItemLines(block.data?.items, lines);
        break;
      // Current table blocks store a full Univer workbook snapshot; older
      // ones (not yet migrated) still carry the pre-Univer content grid.
      // Both are read here so search stays correct regardless of migration
      // status.
      case 'table':
        if (block.data?.workbook) {
          for (const text of flattenWorkbookCellText(block.data.workbook)) pushIf(lines, text);
        } else {
          for (const row of block.data?.content ?? []) {
            for (const cell of row ?? []) pushIf(lines, plainText(cell));
          }
        }
        break;
      case 'code':
        pushIf(lines, String(block.data?.code ?? '').trim());
        break;
      case 'image':
        pushIf(lines, plainText(block.data?.caption));
        break;
      case 'kanban':
        // Kanban fields are plain text (no inline toolbar), unlike
        // header/paragraph/list/table's HTML.
        for (const lane of block.data?.lanes ?? []) {
          pushIf(lines, lane?.title);
          for (const task of lane?.tasks ?? []) {
            pushIf(lines, task?.title);
            pushIf(lines, task?.description);
          }
        }
        break;
      default:
        break;
    }
  }
  return lines.filter(Boolean).join('\n').trim();
}
