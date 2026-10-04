/** Editor.js block text is HTML; escape plain text before storing it. */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Plain text (with optional Markdown headings and "- " bullet lines) to
 * Editor.js blocks: blank lines separate blocks; "# ".."###### " become
 * headers; consecutive "- "/"* " lines become one unordered list.
 * @param {string} text
 */
export function textToBlocks(text) {
  /** @type {any[]} */
  const blocks = [];
  for (const chunk of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((line) => line.trim());
    if (!lines.length) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
    if (heading && lines.length === 1) {
      blocks.push({
        type: 'header',
        data: { text: escapeHtml(heading[2].trim()), level: heading[1].length },
      });
    } else if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      blocks.push({
        type: 'list',
        data: {
          style: 'unordered',
          items: lines.map((line) => ({
            content: escapeHtml(line.replace(/^\s*[-*]\s+/, '')),
            items: [],
          })),
        },
      });
    } else {
      blocks.push({ type: 'paragraph', data: { text: lines.map(escapeHtml).join('<br>') } });
    }
  }
  return blocks;
}

/**
 * Editor.js blocks to readable text for agents. Mirrors the types
 * cookie-web-tasks indexes for search; unknown types are skipped.
 * @param {any[]} blocks
 */
export function blocksToText(blocks) {
  /** @param {unknown} html */
  const strip = (html) =>
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  /** @param {any[]} items @param {number} depth */
  const listLines = (items, depth) =>
    (items ?? []).flatMap((item) => [
      `${'  '.repeat(depth)}- ${strip(typeof item === 'string' ? item : item?.content)}`,
      ...(depth < 16 ? listLines(item?.items, depth + 1) : []),
    ]);
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => {
      const data = block?.data ?? {};
      switch (block?.type) {
        case 'header':
          return `${'#'.repeat(Math.min(Math.max(Number(data.level) || 2, 1), 6))} ${strip(data.text)}`;
        case 'paragraph':
          return strip(data.text);
        case 'list':
          return listLines(data.items, 0).join('\n');
        case 'checklist':
          return (data.items ?? [])
            .map((item) => `[${item.checked ? 'x' : ' '}] ${strip(item.text)}`)
            .join('\n');
        case 'code':
          return String(data.code ?? '');
        case 'image':
          return data.caption ? `[image: ${strip(data.caption)}]` : '[image]';
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

const BLOCKS_LIMIT = 100_000;
const EMBEDDED_DATA_LIMIT = 200;
export const EMBEDDED_DATA_OMITTED = '[embedded data omitted]';

/**
 * Raw blocks sized for an agent's context. Documents hold up to 4 MiB of
 * blocks, mostly base64 images, so embedded `data:` values are replaced with a
 * marker and blocks still over the limit are left out. Either makes the result
 * lossy: writing it back would destroy what was omitted.
 * @param {any[]} blocks
 * @returns {{blocks?: any[], blocksLossy?: true}}
 */
export function boundBlocks(blocks) {
  let lossy = false;
  const text = JSON.stringify(blocks, (_key, value) => {
    if (
      typeof value === 'string' &&
      value.length > EMBEDDED_DATA_LIMIT &&
      value.startsWith('data:')
    ) {
      lossy = true;
      return EMBEDDED_DATA_OMITTED;
    }
    return value;
  });
  if (text.length > BLOCKS_LIMIT) return { blocksLossy: true };
  return lossy ? { blocks: JSON.parse(text), blocksLossy: true } : { blocks };
}
