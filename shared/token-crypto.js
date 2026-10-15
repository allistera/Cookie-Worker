// AES-256-GCM for per-user secrets at rest (a Google refresh token, a Todoist
// API token): the browser never sees them, and the database holds only
// ciphertext under a key the Worker carries as a Wrangler secret. One
// module, so every store encrypts the same way and a key's length check and
// the `v1:<iv>:<ciphertext>` wire format are defined once.
//
// The key is 32 random bytes, base64 (`openssl rand -base64 32`). Rotating
// it makes every stored value undecryptable; the owning feature has to tell
// people to reconnect.

/** @param {string} base64 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** @param {Uint8Array} bytes */
export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** @type {Map<string, Promise<CryptoKey>>} */
const importedKeys = new Map();

/**
 * The imported key, cached per encoded key so a Worker that handles many
 * requests imports it once. Only one key is ever live at a time; a different
 * one (a rotation, or a test with its own key) replaces the cache.
 *
 * @param {string} encodedKey Base64 of exactly 32 random bytes.
 */
function importKey(encodedKey) {
  let imported = importedKeys.get(encodedKey);
  if (!imported) {
    const bytes = base64ToBytes(encodedKey);
    if (bytes.length !== 32) {
      throw new Error('The token encryption key must decode to 32 bytes');
    }
    imported = crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    importedKeys.clear();
    importedKeys.set(encodedKey, imported);
  }
  return imported;
}

/**
 * @param {string} plaintext
 * @param {string} encodedKey
 * @returns {Promise<string>} `v1:<iv>:<ciphertext>`, both base64.
 */
export async function encryptToken(plaintext, encodedKey) {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/**
 * @param {string} stored
 * @param {string} encodedKey
 */
export async function decryptToken(stored, encodedKey) {
  const [version, iv, ciphertext] = String(stored).split(':');
  if (version !== 'v1' || !iv || !ciphertext) throw new Error('Unrecognized token ciphertext');
  const key = await importKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}
