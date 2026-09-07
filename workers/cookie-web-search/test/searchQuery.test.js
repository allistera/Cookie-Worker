// Ported from Cookie-Web's api/_lib/__tests__/search-query.test.js.
import { describe, expect, it } from 'vitest';

import { fetchSearchEmails } from '../src/search.js';

describe('fetchSearchEmails', () => {
  it('returns AI summary presence for search-result lists without returning the summary text', () => {
    let query = '';
    /** @type {any} */
    const sql = (strings) => {
      query = strings.join('?');
      return [];
    };

    fetchSearchEmails(sql, 'owner@example.com', ['11111111-1111-1111-1111-111111111111']);

    expect(query).toContain("NULLIF(BTRIM(t.ai_summary), '') IS NOT NULL");
    expect(query).toContain('t.ai_summary_message_id');
    expect(query).toContain('ORDER BY newest.sent_at DESC, newest.id DESC');
    expect(query).toContain('AS has_ai_summary');
    expect(query).toContain('JOIN threads t ON t.id = m.thread_id');
    expect(query).toContain('LEFT JOIN message_ai ai ON ai.message_id = m.id');
    expect(query).toContain('GROUP BY m.id, ai.spam_score, ai.spam_verdict');
    expect(query).toContain('NOT m.is_deleted');
    expect(query).toContain('m.is_sent');
    expect(query).toContain('m.follow_up_at');
    expect(query).toContain('AS has_html');
    expect(query).toContain('AS has_attachments');
    expect(query).toContain("'kind', l.kind");
    expect(query).not.toContain('body_text');
    expect(query).not.toContain('ai.summary');
  });
});
