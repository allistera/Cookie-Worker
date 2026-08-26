// Ported from Cookie-Web's api/_lib/__tests__/retrieval-query.test.js.
import { describe, expect, it } from 'vitest';

import { keywordLeg, recencyLeg, vectorLeg } from '../src/retrieval.js';

// A minimal stand-in for postgres.js tagged templates: a `sql` tag returns a
// fragment, and interpolated fragments are spliced in while plain values become
// a `$` placeholder — enough to assert on the composed SQL text, including the
// conditionally-added prefix and filter fragments.
function makeSql() {
  const sql = (strings, ...values) => ({ __frag: true, strings, values });
  const render = (node) => {
    if (!node || !node.__frag) return '$';
    return node.strings.reduce(
      (acc, part, i) => (i === 0 ? part : acc + render(node.values[i - 1]) + part),
      '',
    );
  };
  return { sql, render };
}

const NO_FILTERS = { from: undefined, to: undefined };

describe('keywordLeg', () => {
  it('matches free text only when there is no prefix query', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'invoice', prefixQuery: null, filters: {} },
        20,
      ),
    );
    expect(q).toContain("websearch_to_tsquery('english', $)");
    expect(q).not.toContain('OR m.search @@');
    expect(q).not.toContain('GREATEST(');
    expect(q).toContain('ORDER BY');
    expect(q).toContain('ts_rank(');
    // Relevance is primary; recency is only a tie-breaker, so free-text search
    // is not date-sorted.
    expect(q).toMatch(/ORDER BY[\s\S]*DESC, m\.sent_at DESC/);
  });

  it('adds a prefix match and GREATEST rank when a prefix query is present', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'kitchen tile', prefixQuery: 'kitchen & tile:*', filters: {} },
        20,
      ),
    );
    expect(q).toContain("to_tsquery('english', $)");
    expect(q).toContain('OR m.search @@');
    expect(q).toContain('GREATEST(');
  });

  it('applies sender/tag/to/date/attachment filters', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        {
          text: 'x',
          prefixQuery: null,
          filters: {
            from: 'alice',
            tag: 'Personal',
            to: 'bob',
            hasAttachment: true,
            before: '2026-01-31',
            after: '2026-01-01',
          },
        },
        20,
      ),
    );
    expect(q).toContain('m.from_address ILIKE');
    expect(q).toContain('coalesce(m.from_name');
    expect(q).toContain('jsonb_array_elements');
    expect(q).toContain("rcpt->>'address'");
    expect(q).toContain("m.recipients->'to'");
    expect(q).toContain('FROM message_labels tagged_ml');
    expect(q).toContain('JOIN labels tagged_l ON tagged_l.id = tagged_ml.label_id');
    expect(q).toContain('tagged_l.name ILIKE');
    expect(q).toContain('EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)');
    expect(q).toContain('m.sent_at < $::date');
    expect(q).toContain('m.sent_at >= $::date');
  });
});

describe('recencyLeg', () => {
  it('orders by sent_at and keeps the text predicate when text is present', () => {
    const { sql, render } = makeSql();
    const q = render(
      recencyLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'report', prefixQuery: null, filters: {} },
        20,
      ),
    );
    expect(q).toContain('ORDER BY m.sent_at DESC');
    expect(q).toContain("websearch_to_tsquery('english', $)");
  });

  it('drops the text predicate for a filters-only query', () => {
    const { sql, render } = makeSql();
    const q = render(
      recencyLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: '', prefixQuery: null, filters: { from: 'alice' } },
        20,
      ),
    );
    expect(q).not.toContain('websearch_to_tsquery');
    expect(q).toContain('m.from_address ILIKE');
    expect(q).toContain('ORDER BY m.sent_at DESC');
  });
});

describe('vectorLeg', () => {
  it('orders by cosine distance and applies filters', () => {
    const { sql, render } = makeSql();
    const q = render(
      vectorLeg(sql, '11111111-1111-4111-8111-111111111111', '[0.1]', { from: 'alice' }, 20),
    );
    expect(q).toContain('m.embedding <=> $::extensions.vector');
    expect(q).toContain('m.embedding IS NOT NULL');
    expect(q).toContain('m.from_address ILIKE');
  });

  it('adds no filter predicates when filters are empty', () => {
    const { sql, render } = makeSql();
    const q = render(vectorLeg(sql, '11111111-1111-4111-8111-111111111111', '[0.1]', {}, 20));
    expect(q).not.toContain('ILIKE');
    expect(q).toContain('ORDER BY m.embedding');
  });
});

// NO_FILTERS documents that undefined operator keys are simply skipped.
describe('filterClause via keywordLeg', () => {
  it('adds nothing for all-undefined filters', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'x', prefixQuery: null, filters: NO_FILTERS },
        20,
      ),
    );
    expect(q).not.toContain('ILIKE');
  });
});

describe('in: folder scoping', () => {
  it('scopes every leg to non-archived, non-deleted mail by default (no in:)', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'x', prefixQuery: null, filters: {} },
        20,
      ),
    );
    expect(q).toContain('AND NOT m.is_deleted AND NOT m.is_archived');
    expect(q).not.toContain('m.is_sent');
    expect(q).toContain('LEFT JOIN message_ai ai ON ai.message_id = m.id');
  });

  it('in:all drops the archived restriction but still excludes trashed mail', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'x', prefixQuery: null, filters: { in: 'all' } },
        20,
      ),
    );
    expect(q).toContain('AND NOT m.is_deleted');
    expect(q).not.toContain('is_archived');
  });

  it('in:done scopes to archived mail only', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'x', prefixQuery: null, filters: { in: 'done' } },
        20,
      ),
    );
    expect(q).toContain('AND NOT m.is_deleted AND m.is_archived');
  });

  it('in:spam matches the spam folder predicate (non-archived, not sent, spam verdict)', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'x', prefixQuery: null, filters: { in: 'spam' } },
        20,
      ),
    );
    expect(q).toContain('NOT m.is_archived AND NOT m.is_sent AND ai.spam_verdict = ');
  });

  it('in:sent, in:snoozed, and in:inbox scope recencyLeg and vectorLeg too', () => {
    const { sql, render } = makeSql();
    expect(
      render(
        recencyLeg(
          sql,
          '11111111-1111-4111-8111-111111111111',
          { text: '', prefixQuery: null, filters: { in: 'sent' } },
          20,
        ),
      ),
    ).toContain('AND m.is_sent');
    expect(
      render(
        recencyLeg(
          sql,
          '11111111-1111-4111-8111-111111111111',
          { text: '', prefixQuery: null, filters: { in: 'snoozed' } },
          20,
        ),
      ),
    ).toContain('m.scheduled_for > now()');
    expect(
      render(vectorLeg(sql, '11111111-1111-4111-8111-111111111111', '[0.1]', { in: 'inbox' }, 20)),
    ).toContain('m.scheduled_for IS NULL OR m.scheduled_for <= now()');
  });

  it('ignores an unrecognised in: value the same as no filter', () => {
    const { sql, render } = makeSql();
    const q = render(
      keywordLeg(
        sql,
        '11111111-1111-4111-8111-111111111111',
        { text: 'x', prefixQuery: null, filters: { in: 'trash' } },
        20,
      ),
    );
    expect(q).toContain('AND NOT m.is_deleted AND NOT m.is_archived');
  });
});
