/**
 * Hashing both sides to a fixed-length SHA-256 digest before comparing means
 * a manual constant-time byte comparison works regardless of the two
 * strings' actual lengths, and neither a length nor a byte-value mismatch is
 * distinguishable by comparison time. Mirrors Cookie-Web's api/send.js
 * timingSafeEqualStrings, but built on Web Crypto only (no node:crypto),
 * since importing that here drags @types/node into every worker's checkJs
 * program and breaks typecheck on unrelated node_modules.
 *
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {Promise<boolean>}
 */
export async function timingSafeEqualStrings(a, b) {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a ?? ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b ?? ''))),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i += 1) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}
