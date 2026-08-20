import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_TAGS,
  normalizeDocumentTag,
  normalizeDocumentTags,
} from '../src/documentTags.js';

describe('document tags', () => {
  it('normalizes a leading hash, case, whitespace, and duplicates', () => {
    expect(normalizeDocumentTag('  #Project-One  ')).toBe('project-one');
    expect(normalizeDocumentTags(['#Foo', 'foo', 'HOME_notes'])).toEqual(['foo', 'home_notes']);
  });

  it('rejects invalid tag characters and non-arrays', () => {
    expect(normalizeDocumentTag('two words')).toBeNull();
    expect(normalizeDocumentTag('#')).toBeNull();
    expect(normalizeDocumentTags('foo')).toBeNull();
  });

  it('bounds the number of tags', () => {
    const tags = Array.from({ length: MAX_DOCUMENT_TAGS + 1 }, (_, index) => `tag-${index}`);
    expect(normalizeDocumentTags(tags)).toBeNull();
  });
});
