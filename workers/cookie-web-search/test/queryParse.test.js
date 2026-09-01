// Ported from Cookie-Web's api/_lib/__tests__/query-parse.test.js (the
// mail-search half; Cookie-Web keeps its copy for the vite fixture).
import { describe, expect, it } from 'vitest';

import { hasMailOnlyFilters, parseFederatedSearchQuery, parseSearchQuery } from '../src/queryParse.js';

describe('parseSearchQuery', () => {
  it('leaves a plain query as free text', () => {
    const { text, filters } = parseSearchQuery('kitchen tile');
    expect(text).toBe('kitchen tile');
    expect(filters).toEqual({});
  });

  it('extracts from: and to: operators and removes them from the text', () => {
    const { text, filters } = parseSearchQuery('from:alice invoice');
    expect(text).toBe('invoice');
    expect(filters).toEqual({ from: 'alice' });
  });

  it('supports sender: as a readable alias for from:', () => {
    const { text, filters } = parseSearchQuery('sender:foo@bar.com invoice');
    expect(text).toBe('invoice');
    expect(filters).toEqual({ from: 'foo@bar.com' });
  });

  it('extracts tag: filters, including quoted tag names', () => {
    expect(parseSearchQuery('tag:Personal').filters).toEqual({ tag: 'Personal' });
    expect(parseSearchQuery('tag:"Close Friends" photos').filters).toEqual({
      tag: 'Close Friends',
    });
  });

  it('supports quoted operator values', () => {
    const { text, filters } = parseSearchQuery('to:"Jane Doe" lunch');
    expect(text).toBe('lunch');
    expect(filters).toEqual({ to: 'Jane Doe' });
  });

  it('recognises has:attachment and has:attachments', () => {
    expect(parseSearchQuery('has:attachment').filters).toEqual({ hasAttachment: true });
    expect(parseSearchQuery('has:attachments').filters).toEqual({ hasAttachment: true });
  });

  it('parses valid before:/after: dates and drops invalid ones', () => {
    expect(parseSearchQuery('before:2026-01-31').filters).toEqual({ before: '2026-01-31' });
    const { text, filters } = parseSearchQuery('after:yesterday report');
    expect(filters).toEqual({});
    expect(text).toBe('after:yesterday report');
  });

  it('leaves an unknown has: value as free text', () => {
    const { text, filters } = parseSearchQuery('has:banana');
    expect(filters).toEqual({});
    expect(text).toBe('has:banana');
  });

  it('yields empty free text for a filters-only query', () => {
    const { text, filters } = parseSearchQuery('from:alice has:attachment');
    expect(text).toBe('');
    expect(filters).toEqual({ from: 'alice', hasAttachment: true });
  });

  it('combines several operators with free text', () => {
    const { text, filters } = parseSearchQuery(
      'sender:bob to:alice tag:Work after:2026-01-01 budget plan',
    );
    expect(text).toBe('budget plan');
    expect(filters).toEqual({ from: 'bob', to: 'alice', tag: 'Work', after: '2026-01-01' });
  });

  it('extracts in: for every supported folder, case-insensitively', () => {
    expect(parseSearchQuery('in:all project').filters).toEqual({ in: 'all' });
    expect(parseSearchQuery('in:Done project').filters).toEqual({ in: 'done' });
    expect(parseSearchQuery('in:SPAM project').filters).toEqual({ in: 'spam' });
    expect(parseSearchQuery('in:inbox').filters).toEqual({ in: 'inbox' });
    expect(parseSearchQuery('in:sent').filters).toEqual({ in: 'sent' });
    expect(parseSearchQuery('in:snoozed').filters).toEqual({ in: 'snoozed' });
  });

  it('leaves an unknown in: value as free text', () => {
    const { text, filters } = parseSearchQuery('in:trash report');
    expect(filters).toEqual({});
    expect(text).toBe('in:trash report');
  });
});

describe('parseFederatedSearchQuery', () => {
  it('understands every mail operator parseSearchQuery does', () => {
    const { text, filters } = parseFederatedSearchQuery(
      'sender:bob to:alice tag:Work after:2026-01-01 has:attachment in:done budget',
    );
    expect(text).toBe('budget');
    expect(filters).toEqual({
      from: 'bob',
      to: 'alice',
      tag: 'Work',
      after: '2026-01-01',
      hasAttachment: true,
      in: 'done',
    });
  });

  it('also recognises is:starred, which parseSearchQuery does not', () => {
    expect(parseSearchQuery('is:starred').filters).toEqual({});

    const { text, filters } = parseFederatedSearchQuery('is:starred report');
    expect(text).toBe('report');
    expect(filters).toEqual({ starred: true });
  });

  it('leaves an unknown is: value as free text', () => {
    const { text, filters } = parseFederatedSearchQuery('is:pinned report');
    expect(filters).toEqual({});
    expect(text).toBe('is:pinned report');
  });

  it('combines tag: and is:starred, the two operators shared by both indexes', () => {
    const { filters } = parseFederatedSearchQuery('tag:Work is:starred budget');
    expect(filters).toEqual({ tag: 'Work', starred: true });
  });
});

describe('hasMailOnlyFilters', () => {
  it('is false for filters with only tag/starred', () => {
    expect(hasMailOnlyFilters({})).toBe(false);
    expect(hasMailOnlyFilters({ tag: 'Work' })).toBe(false);
    expect(hasMailOnlyFilters({ starred: true })).toBe(false);
    expect(hasMailOnlyFilters({ tag: 'Work', starred: true })).toBe(false);
  });

  it.each([
    ['from', { from: 'bob' }],
    ['to', { to: 'alice' }],
    ['hasAttachment', { hasAttachment: true }],
    ['before', { before: '2026-01-01' }],
    ['after', { after: '2026-01-01' }],
    ['in', { in: 'inbox' }],
  ])('is true when %s is present', (_key, filters) => {
    expect(hasMailOnlyFilters(filters)).toBe(true);
  });

  it('is true when a mail-only operator is combined with tag/starred', () => {
    expect(hasMailOnlyFilters({ tag: 'Work', from: 'bob' })).toBe(true);
  });
});
