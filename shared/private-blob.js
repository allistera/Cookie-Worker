/**
 * The pathname inside Cookie's private Vercel Blob store for a stored blob
 * URL. Throws for anything that is not a private-store URL, so a caller can
 * never be tricked into signing a public or foreign URL.
 *
 * @param {string} blobUrl
 */
export function privateBlobPathname(blobUrl) {
  const url = new URL(blobUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.private.blob.vercel-storage.com')) {
    throw new Error('Not a private Blob storage URL');
  }
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}
