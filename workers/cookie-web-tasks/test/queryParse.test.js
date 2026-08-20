import { describe, expect, it } from 'vitest';
import { buildPrefixQuery, parseDocumentSearchQuery } from '../src/queryParse.js';

describe('buildPrefixQuery', () => {
  it('makes the last word a prefix and requires every word', () => {
    expect(buildPrefixQuery('kitchen tile')).toBe('kitchen & tile:*');
  });

  it('makes a single word a prefix so an in-progress word still matches', () => {
    expect(buildPrefixQuery('invoi')).toBe('invoi:*');
  });

  it('returns null when there is no alphanumeric word', () => {
    expect(buildPrefixQuery('!!!')).toBeNull();
    expect(buildPrefixQuery('')).toBeNull();
  });
});

describe('parseDocumentSearchQuery', () => {
  it('extracts tag: filters, including quoted tag names', () => {
    expect(parseDocumentSearchQuery('tag:Personal').filters).toEqual({ tag: 'Personal' });
    expect(parseDocumentSearchQuery('tag:"Close Friends" notes').filters).toEqual({
      tag: 'Close Friends',
    });
  });

  it('extracts is:starred', () => {
    const { text, filters } = parseDocumentSearchQuery('is:starred roadmap');
    expect(text).toBe('roadmap');
    expect(filters).toEqual({ starred: true });
  });

  it('leaves an unknown is: value as free text', () => {
    const { text, filters } = parseDocumentSearchQuery('is:archived report');
    expect(filters).toEqual({});
    expect(text).toBe('is:archived report');
  });

  it('does not recognize email-only operators like from:/to:/has:/in:', () => {
    const { text, filters } = parseDocumentSearchQuery('from:alice has:attachment invoice');
    expect(filters).toEqual({});
    expect(text).toBe('from:alice has:attachment invoice');
  });

  it('combines tag: and is:starred with free text', () => {
    const { text, filters } = parseDocumentSearchQuery('tag:Work is:starred budget plan');
    expect(text).toBe('budget plan');
    expect(filters).toEqual({ tag: 'Work', starred: true });
  });

  it('yields empty free text and a null prefix query for a filters-only query', () => {
    const { text, prefixQuery, filters } = parseDocumentSearchQuery('tag:Work is:starred');
    expect(text).toBe('');
    expect(prefixQuery).toBeNull();
    expect(filters).toEqual({ tag: 'Work', starred: true });
  });
});
