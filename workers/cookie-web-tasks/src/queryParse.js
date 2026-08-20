// Ported from Cookie-Web's api/_lib/query-parse.js — pure JS, no Node APIs.
// Only buildPrefixQuery and parseDocumentSearchQuery are ported: the
// original file's parseSearchQuery (from:/sender:/to:/has:/before:/after:/
// in: operators) is email-search-specific and unused by this Worker.
//
// Parses a raw search string into the free-text portion, a prefix tsquery
// for search-as-you-type, and structured operators (tag:/is:starred). Kept
// separate from the SQL legs so the parsing rules can be unit-tested without
// a database.

// tag:Personal  is:starred
// A narrower operator set than email search: documents have no
// sender/recipients/attachments/folders, so from:/to:/has:/before:/after:/
// in: would silently accept and drop values that map to nothing, which is a
// confusing rough edge. Only the two operators that map to real document
// columns (tags, starred) are recognized here; everything else stays as free
// text, including a bare "is:" with an unrecognized value.
const DOCUMENT_OPERATOR_RE = /(tag|is):("[^"]*"|\S+)/gi;

/**
 * Builds a prefix tsquery like `kitchen & tile:*` from free text: every word
 * is required (AND) and the final word is a prefix match, so an in-progress
 * last word ("invoi") still matches completed terms ("invoice"). Returns
 * null when there is no alphanumeric word to match. Words are reduced to
 * letters/digits, so the `:*` appended is the only tsquery operator — the
 * value is safe to hand to to_tsquery without injection risk.
 *
 * @param {string} text
 */
export function buildPrefixQuery(text) {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length === 0) return null;
  return words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w)).join(' & ');
}

/** @param {string} raw */
export function parseDocumentSearchQuery(raw) {
  /** @type {{tag?: string, starred?: true}} */
  const filters = {};
  const text = raw
    .replace(DOCUMENT_OPERATOR_RE, (match, key, rawValue) => {
      const value = rawValue.startsWith('"') ? rawValue.slice(1, -1).trim() : rawValue.trim();
      switch (key.toLowerCase()) {
        case 'tag':
          if (value) filters.tag = value;
          break;
        case 'is':
          if (/^starred$/i.test(value)) filters.starred = true;
          else return match; // unknown is: value — leave it as free text
          break;
      }
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  return { text, prefixQuery: buildPrefixQuery(text), filters };
}
