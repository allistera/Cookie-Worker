// Ported from Cookie-Web's api/_lib/__tests__/query-parse.test.js (the
// mail-search half; Cookie-Web keeps its copy for the vite fixture).
import { describe, expect, it } from 'vitest';

import { parseSearchQuery } from '../src/queryParse.js';

describe('parseSearchQuery', () => {
  it('leaves a plain query as free text with a prefix on the last word', () => {
    const { text, prefixQuery, filters } = parseSearchQuery('kitchen tile');
    expect(text).toBe('kitchen tile');
    expect(prefixQuery).toBe('kitchen & tile:*');
    expect(filters).toEqual({});
  });

  it('makes a single word a prefix so an in-progress word still matches', () => {
    expect(parseSearchQuery('invoi').prefixQuery).toBe('invoi:*');
  });

  it('has no prefix query when there is no alphanumeric word', () => {
    expect(parseSearchQuery('!!!').prefixQuery).toBeNull();
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
    const { text, prefixQuery, filters } = parseSearchQuery('from:alice has:attachment');
    expect(text).toBe('');
    expect(prefixQuery).toBeNull();
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
