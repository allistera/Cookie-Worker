// Allow-list sanitiser for the inline HTML that Editor.js keeps in document
// blocks. It uses the same allow-list as the browser's DOMPurify call in
// Cookie-Web src/lib/documentExport.js: a few inline tags, and only href on
// links. Workers have no DOM (and HTMLRewriter is a streaming Response API),
// so this is one linear pass over the string with no regex backtracking.

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'a', 'br']);
// Elements whose content is dropped along with the tag, as DOMPurify does.
const DROP_CONTENT_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'noscript',
  'noembed',
  'noframes',
  'xmp',
  'textarea',
  'title',
  'plaintext',
  'template',
  'svg',
  'math',
]);
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);
// Enough named references to read a URL scheme; anything else stays encoded
// and so cannot pass the scheme check below.
/** @type {Record<string, string>} */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  tab: '\t',
  newline: '\n',
  nbsp: ' ',
};

/** @param {string | undefined} char */
function isSpace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/** @param {string | undefined} char */
function isLetter(char) {
  return char !== undefined && ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z'));
}

// Text between tags: keep character references, escape a bare `&` and `>`.
/** @param {string} text */
function escapeText(text) {
  return text
    .replace(/&(?!#x[0-9a-f]+;|#[0-9]+;|[a-z][a-z0-9]*;)/gi, '&amp;')
    .replaceAll('>', '&gt;');
}

/** @param {string} value */
function escapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** @param {string} value */
function decodeEntities(value) {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]*));?/gi,
    (match, hex, decimal, name) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
      const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(decimal, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    },
  );
}

// The href as the browser would read it, or null unless it is http, https or
// mailto. Browsers drop tabs and newlines anywhere in a URL and control
// characters or spaces at either end, so the same is done before the scheme
// is read. A relative URL has no scheme and is dropped too.
/** @param {string} raw */
function safeHref(raw) {
  const url = decodeEntities(raw).replace(/[\t\n\r]/g, '');
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && url.charCodeAt(end - 1) <= 0x20) end -= 1;
  const clean = url.slice(start, end);
  const colon = clean.indexOf(':');
  if (colon === -1 || !SAFE_SCHEMES.has(clean.slice(0, colon).toLowerCase())) return null;
  return clean;
}

/**
 * Reads the markup that starts with the `<` at `start`.
 * Returns null when the `<` does not start a tag (it is then text), `skip`
 * for comments and tags cut off by the end of the input, or the tag itself.
 * Only the first href is kept; no other attribute is ever used.
 *
 * @param {string} html
 * @param {number} start
 * @returns {null | {end: number, skip: true} | {end: number, skip?: false, name: string, closing: boolean, href: string | null}}
 */
function readTag(html, start) {
  const length = html.length;
  if (html.startsWith('<!--', start)) {
    const close = html.indexOf('-->', start + 2);
    return { end: close === -1 ? length : close + 3, skip: true };
  }
  const next = html[start + 1];
  const closing = next === '/';
  if (next === '!' || next === '?' || (closing && !isLetter(html[start + 2]))) {
    if (next === '/' && html[start + 2] === undefined) return null;
    const close = html.indexOf('>', start + 1);
    return { end: close === -1 ? length : close + 1, skip: true };
  }
  let j = start + (closing ? 2 : 1);
  if (!isLetter(html[j])) return null;

  const nameStart = j;
  while (j < length && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j += 1;
  const name = html.slice(nameStart, j).toLowerCase();

  /** @type {string | null} */
  let href = null;
  while (true) {
    while (j < length && (isSpace(html[j]) || html[j] === '/')) j += 1;
    if (j >= length) return { end: length, skip: true };
    if (html[j] === '>') return { end: j + 1, name, closing, href };

    const attrStart = j;
    j += 1;
    while (j < length && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=')
      j += 1;
    const attr = html.slice(attrStart, j).toLowerCase();
    while (j < length && isSpace(html[j])) j += 1;
    if (html[j] !== '=') continue;
    j += 1;
    while (j < length && isSpace(html[j])) j += 1;
    let value;
    const quote = html[j];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, j + 1);
      if (close === -1) return { end: length, skip: true };
      value = html.slice(j + 1, close);
      j = close + 1;
    } else {
      const valueStart = j;
      while (j < length && !isSpace(html[j]) && html[j] !== '>') j += 1;
      value = html.slice(valueStart, j);
    }
    if (attr === 'href' && href === null) href = value;
  }
}

// Index just past the end tag that closes a dropped element, or the end of
// the input when it is never closed.
/** @param {string} html @param {number} from @param {string} name */
function skipElementContent(html, from, name) {
  let at = html.indexOf('</', from);
  while (at !== -1) {
    const after = html[at + 2 + name.length];
    if (
      html.slice(at + 2, at + 2 + name.length).toLowerCase() === name &&
      (after === undefined || after === '>' || after === '/' || isSpace(after))
    ) {
      const close = html.indexOf('>', at);
      return close === -1 ? html.length : close + 1;
    }
    at = html.indexOf('</', at + 2);
  }
  return html.length;
}

/**
 * Keeps the allowed inline tags (links only with an http, https or mailto
 * href), drops every other tag but keeps its text, drops comments and the
 * content of script-like elements, and escapes stray `<`, `>` and `&`. The
 * result is balanced, and sanitising it again returns it unchanged.
 *
 * @param {string} html
 */
export function sanitizeInlineHtml(html) {
  let out = '';
  /** @type {string[]} */
  const open = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += escapeText(html.slice(i));
      break;
    }
    out += escapeText(html.slice(i, lt));
    const tag = readTag(html, lt);
    if (!tag) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (tag.skip) continue;
    const { name, closing } = tag;
    if (!closing && DROP_CONTENT_TAGS.has(name)) {
      i = skipElementContent(html, i, name);
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      if (!open.includes(name)) continue;
      let top;
      do {
        top = open.pop();
        out += `</${top}>`;
      } while (top !== name);
    } else if (name === 'br') {
      out += '<br>';
    } else {
      const href = name === 'a' && tag.href !== null ? safeHref(tag.href) : null;
      out += href === null ? `<${name}>` : `<a href="${escapeAttribute(href)}">`;
      open.push(name);
    }
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/** @param {any} value */
function inlineText(value) {
  return String(value) === value ? sanitizeInlineHtml(value) : value;
}

/** @param {any} items @returns {any} */
function sanitizeListItems(items) {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (String(item) === item) return sanitizeInlineHtml(item);
    if (Object(item) !== item || Array.isArray(item)) return item;
    const copy = { ...item };
    if (Object.hasOwn(copy, 'content')) copy.content = inlineText(copy.content);
    if (Object.hasOwn(copy, 'text')) copy.text = inlineText(copy.text);
    if (Object.hasOwn(copy, 'items')) copy.items = sanitizeListItems(copy.items);
    return copy;
  });
}

/**
 * Sanitises the HTML Editor.js renders from stored blocks: paragraph and
 * header text, list items at every depth (both list formats) and image
 * captions. Other block types and non-string fields pass through untouched.
 * Returns a new array; the input is not changed.
 *
 * @param {any[]} blocks
 */
export function sanitizeDocumentBlocks(blocks) {
  return blocks.map((block) => {
    const data = block?.data;
    if (Object(data) !== data || Array.isArray(data)) return block;
    if (block.type === 'paragraph' || block.type === 'header') {
      if (!Object.hasOwn(data, 'text')) return block;
      return { ...block, data: { ...data, text: inlineText(data.text) } };
    }
    if (block.type === 'list' && Object.hasOwn(data, 'items')) {
      return { ...block, data: { ...data, items: sanitizeListItems(data.items) } };
    }
    if (block.type === 'image' && Object.hasOwn(data, 'caption')) {
      return { ...block, data: { ...data, caption: inlineText(data.caption) } };
    }
    return block;
  });
}
