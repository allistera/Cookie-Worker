import { describe, expect, it } from 'vitest';
import {
  documentsDriftPage,
  documentsPage,
  messagesDriftPage,
  messagesPage,
  stampIndexed,
} from './queries.js';

// A minimal stand-in for postgres.js tagged templates: a `sql` tag returns a
// fragment, and interpolated fragments are spliced in while plain values
// become a `$` placeholder — enough to assert on the composed SQL text.
// Mirrors workers/cookie-web-tasks/test/documentRetrieval.test.js's helper.
function makeSql() {
  /** @type {any} */
  const sql = (/** @type {any} */ strings, /** @type {any[]} */ ...values) => ({
    __frag: true,
    strings,
    values,
  });
  /** @param {any} node */
  const render = (node) => {
    if (!node || !node.__frag) return '$';
    return node.strings.reduce(
      (/** @type {string} */ acc, /** @type {string} */ part, /** @type {number} */ i) =>
        i === 0 ? part : acc + render(node.values[i - 1]) + part,
      '',
    );
  };
  return { sql, render };
}

describe('documentsPage', () => {
  it('has no cursor predicate on the first page', () => {
    const { sql, render } = makeSql();
    const q = render(documentsPage(sql, { afterId: null, limit: 100 }));
    expect(q).not.toContain('id > $');
    expect(q).toContain('WHERE true');
    expect(q).toContain('ORDER BY id');
    expect(q).toContain('LIMIT $');
  });

  it('adds a keyset cursor once a page has run', () => {
    const { sql, render } = makeSql();
    const q = render(documentsPage(sql, { afterId: 'some-id', limit: 100 }));
    expect(q).toContain('AND id > $');
  });

  it('selects exactly the columns DOCUMENTS_INDEX.toDocument reads', () => {
    const { sql, render } = makeSql();
    const q = render(documentsPage(sql, { afterId: null, limit: 100 }));
    expect(q).toContain('id, user_id, title, content_text, tags, starred, updated_at');
  });
});

describe('messagesPage', () => {
  it('has no cursor predicate on the first page', () => {
    const { sql, render } = makeSql();
    const q = render(messagesPage(sql, { afterId: null, limit: 100 }));
    expect(q).not.toContain('m.id > $');
    expect(q).toContain('WHERE true');
    expect(q).toContain('ORDER BY m.id');
  });

  it('adds a keyset cursor once a page has run', () => {
    const { sql, render } = makeSql();
    const q = render(messagesPage(sql, { afterId: 'some-id', limit: 100 }));
    expect(q).toContain('AND m.id > $');
  });

  it('joins message_ai and aggregates labels, like meiliSync.js', () => {
    const { sql, render } = makeSql();
    const q = render(messagesPage(sql, { afterId: null, limit: 100 }));
    expect(q).toContain('LEFT JOIN message_labels ml ON ml.message_id = m.id');
    expect(q).toContain('LEFT JOIN labels l ON l.id = ml.label_id');
    expect(q).toContain('LEFT JOIN message_ai ai ON ai.message_id = m.id');
    expect(q).toContain('GROUP BY m.id, ai.spam_verdict');
    expect(q).toContain('AS labels');
    expect(q).toContain('AS has_attachments');
  });
});

describe('documentsDriftPage', () => {
  it('selects rows never indexed or indexed before their last update', () => {
    const { sql, render } = makeSql();
    const q = render(documentsDriftPage(sql, { limit: 500 }));
    expect(q).toContain('search_indexed_at IS NULL OR search_indexed_at < updated_at');
    expect(q).toContain('ORDER BY updated_at');
  });
});

describe('messagesDriftPage', () => {
  // messages has no updated_at column (see Cookie-Web migration
  // 0055_search_indexed_at.sql), so unlike documents this can only ask for
  // never-indexed rows — and must match messages_search_drift_idx's
  // predicate/ordering exactly (search_indexed_at IS NULL, keyed on
  // created_at) or that partial index won't be used.
  it('selects only never-indexed rows, ordered by created_at', () => {
    const { sql, render } = makeSql();
    const q = render(messagesDriftPage(sql, { limit: 500 }));
    expect(q).toContain('m.search_indexed_at IS NULL');
    expect(q).not.toContain('search_indexed_at <');
    expect(q).not.toContain('m.updated_at');
    expect(q).toContain('ORDER BY m.created_at');
  });

  it('joins message_ai and aggregates labels, like meiliSync.js', () => {
    const { sql, render } = makeSql();
    const q = render(messagesDriftPage(sql, { limit: 500 }));
    expect(q).toContain('LEFT JOIN message_ai ai ON ai.message_id = m.id');
    expect(q).toContain('GROUP BY m.id, ai.spam_verdict');
  });
});

describe('stampIndexed', () => {
  it('stamps the documents table for a documents target', () => {
    const { sql, render } = makeSql();
    const q = render(stampIndexed(sql, 'documents', ['a', 'b']));
    expect(q).toContain('UPDATE documents SET search_indexed_at = now()');
    expect(q).toContain('WHERE id = ANY($::uuid[])');
  });

  it('stamps the messages table for a messages target', () => {
    const { sql, render } = makeSql();
    const q = render(stampIndexed(sql, 'messages', ['a', 'b']));
    expect(q).toContain('UPDATE messages SET search_indexed_at = now()');
  });
});
