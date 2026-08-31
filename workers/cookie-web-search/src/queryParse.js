// Ported from Cookie-Web's api/_lib/query-parse.js (the mail-search half;
// the document-search parser lives in cookie-web-tasks). Cookie-Web keeps
// its own copy for the vite dev/e2e search fixture — kept in sync by hand.
// Parses a raw search string into the free-text portion, a prefix tsquery for
// search-as-you-type, and structured operators
// (from:/sender:/to:/tag:/has:/before:/after:/in:).
// Kept separate from the SQL legs so the parsing rules can be unit-tested
// without a database.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Mirrors the folder values api/emails.js accepts, plus "all" for every
// folder at once (deleted/trashed mail is excluded even by "all" — there is
// no "trash" value in this set).
const FOLDERS = new Set(['inbox', 'sent', 'spam', 'snoozed', 'done', 'all']);

// sender:alice  to:"Jane Doe"  tag:Personal  has:attachment
// before:2026-01-31  after:2026-01-01  in:done
// The value is either a "quoted phrase" or an unbroken run of non-space chars.
const OPERATOR_RE = /(from|sender|to|tag|has|before|after|in):("[^"]*"|\S+)/gi;

// Builds a prefix tsquery like `kitchen & tile:*` from free text: every word is
// required (AND) and the final word is a prefix match, so an in-progress last
// word ("invoi") still matches completed terms ("invoice"). Returns null when
// there is no alphanumeric word to match. Words are reduced to letters/digits,
// so the `:*` we append is the only tsquery operator — the value is safe to
// hand to to_tsquery without injection risk.
export function buildPrefixQuery(text) {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length === 0) return null;
  return words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w)).join(' & ');
}

export function parseSearchQuery(raw) {
  const filters = {};
  const text = raw
    .replace(OPERATOR_RE, (match, key, rawValue) => {
      const value = rawValue.startsWith('"') ? rawValue.slice(1, -1).trim() : rawValue.trim();
      switch (key.toLowerCase()) {
        case 'from':
        case 'sender':
          if (value) filters.from = value;
          break;
        case 'to':
          if (value) filters.to = value;
          break;
        case 'tag':
          if (value) filters.tag = value;
          break;
        case 'has':
          if (/^attachments?$/i.test(value)) filters.hasAttachment = true;
          else return match; // unknown has: value — leave it as free text
          break;
        case 'before':
          if (DATE_RE.test(value)) filters.before = value;
          else return match;
          break;
        case 'after':
          if (DATE_RE.test(value)) filters.after = value;
          else return match;
          break;
        case 'in':
          if (FOLDERS.has(value.toLowerCase())) filters.in = value.toLowerCase();
          else return match; // unknown in: value — leave it as free text
          break;
      }
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  return { text, prefixQuery: buildPrefixQuery(text), filters };
}
