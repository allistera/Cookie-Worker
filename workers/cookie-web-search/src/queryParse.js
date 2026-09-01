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

  return { text, filters };
}

// sender:alice tag:Personal is:starred — the federated (mail + documents)
// search operator set: every mail operator parseSearchQuery understands,
// plus is:starred, which only cookie-web-tasks' document search parser knew
// about before. tag: and is:starred are the two operators meaningful to both
// indexes (see MAIL_ONLY_FILTER_KEYS below for the rest).
const FEDERATED_OPERATOR_RE = /(from|sender|to|tag|has|before|after|in|is):("[^"]*"|\S+)/gi;

/** @param {string} raw */
export function parseFederatedSearchQuery(raw) {
  const filters = {};
  const text = raw
    .replace(FEDERATED_OPERATOR_RE, (match, key, rawValue) => {
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
        case 'is':
          if (/^starred$/i.test(value)) filters.starred = true;
          else return match; // unknown is: value — leave it as free text
          break;
      }
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  return { text, filters };
}

// Filters meaningful only to mail — a document has no sender, recipients,
// attachments, sent date, or folder. When scope=all sees one of these, the
// documents leg of the federated query is dropped entirely rather than run
// with the operator silently ignored (which would just return every
// document as if the operator weren't there).
export const MAIL_ONLY_FILTER_KEYS = ['from', 'to', 'hasAttachment', 'before', 'after', 'in'];

/** @param {Record<string, any>} filters */
export function hasMailOnlyFilters(filters) {
  return MAIL_ONLY_FILTER_KEYS.some((key) => key in filters);
}
