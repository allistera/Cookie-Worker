import { describe, expect, it } from 'vitest';
import { keywordLeg, recencyLeg, vectorLeg } from '../src/documentRetrieval.js';

// A minimal stand-in for postgres.js tagged templates: a `sql` tag returns a
// fragment, and interpolated fragments are spliced in while plain values
// become a `$` placeholder — enough to assert on the composed SQL text,
// including the conditionally-added prefix and filter fragments.
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

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('keywordLeg', () => {
  it('matches free text only when there is no prefix query', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(sql, USER_ID, { text: 'roadmap', prefixQuery: null, filters: {} }, 20),
    );
    expect(q).toContain("websearch_to_tsquery('english', $)");
    expect(q).not.toContain('OR d.search @@');
    expect(q).not.toContain('GREATEST(');
    expect(q).toContain('ts_rank(');
    expect(q).toMatch(/ORDER BY[\s\S]*DESC, d\.updated_at DESC/);
  });

  it('adds a prefix match and GREATEST rank when a prefix query is present', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        USER_ID,
        { text: 'kitchen tile', prefixQuery: 'kitchen & tile:*', filters: {} },
        20,
      ),
    );
    expect(q).toContain("to_tsquery('english', $)");
    expect(q).toContain('OR d.search @@');
    expect(q).toContain('GREATEST(');
  });

  it('applies the tag: filter, normalizing the tag value', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(sql, USER_ID, { text: 'x', prefixQuery: null, filters: { tag: '#Work' } }, 20),
    );
    expect(q).toContain('d.tags @> ARRAY[$]::text[]');
  });

  it('applies the is:starred filter', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(sql, USER_ID, { text: 'x', prefixQuery: null, filters: { starred: true } }, 20),
    );
    expect(q).toContain('d.starred = true');
  });

  it('adds nothing for empty filters', () => {
    const { sql, render } = makeSql();
    const q = render(keywordLeg(sql, USER_ID, { text: 'x', prefixQuery: null, filters: {} }, 20));
    expect(q).not.toContain('d.tags');
    expect(q).not.toContain('d.starred');
  });
});

describe('recencyLeg', () => {
  it('orders by updated_at and keeps the text predicate when text is present', () => {
    const { sql, render } = makeSql();
    const q = render(
      recencyLeg(sql, USER_ID, { text: 'report', prefixQuery: null, filters: {} }, 20),
    );
    expect(q).toContain('ORDER BY d.updated_at DESC');
    expect(q).toContain("websearch_to_tsquery('english', $)");
  });

  it('drops the text predicate for a filters-only query', () => {
    const { sql, render } = makeSql();
    const q = render(
      recencyLeg(sql, USER_ID, { text: '', prefixQuery: null, filters: { starred: true } }, 20),
    );
    expect(q).not.toContain('websearch_to_tsquery');
    expect(q).toContain('d.starred = true');
    expect(q).toContain('ORDER BY d.updated_at DESC');
  });
});

describe('vectorLeg', () => {
  it('orders by cosine distance and applies filters', () => {
    const { sql, render } = makeSql();
    const q = render(vectorLeg(sql, USER_ID, '[0.1]', { tag: 'work' }, 20));
    expect(q).toContain('d.embedding <=> $::extensions.vector');
    expect(q).toContain('d.embedding IS NOT NULL');
    expect(q).toContain('d.tags @> ARRAY[$]::text[]');
  });

  it('adds no filter predicates when filters are empty', () => {
    const { sql, render } = makeSql();
    const q = render(vectorLeg(sql, USER_ID, '[0.1]', {}, 20));
    expect(q).not.toContain('d.tags');
    expect(q).not.toContain('d.starred');
    expect(q).toContain('ORDER BY d.embedding');
  });
});
