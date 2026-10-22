import { describe, expect, it } from 'vitest';
import { privateBlobPathname } from './private-blob.js';

describe('privateBlobPathname', () => {
  it('returns the decoded storage path without query parameters', () => {
    expect(
      privateBlobPathname(
        'https://store.private.blob.vercel-storage.com/mail/hello%20world.pdf?download=1',
      ),
    ).toBe('mail/hello world.pdf');
  });

  it.each([
    'http://store.private.blob.vercel-storage.com/file',
    'https://store.public.blob.vercel-storage.com/file',
    'https://store.private.blob.vercel-storage.com.attacker.example/file',
    'https://private.blob.vercel-storage.com/file',
    'https://store.private.blob.vercel-storage.com@attacker.example/file',
  ])('rejects a URL outside the HTTPS private store: %s', (url) => {
    expect(() => privateBlobPathname(url)).toThrow('Not a private Blob storage URL');
  });

  it('rejects malformed URLs and invalid encoded paths', () => {
    expect(() => privateBlobPathname('not a URL')).toThrow();
    expect(() =>
      privateBlobPathname('https://store.private.blob.vercel-storage.com/%ZZ'),
    ).toThrow();
  });
});
