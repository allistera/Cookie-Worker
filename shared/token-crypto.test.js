import { describe, expect, it } from 'vitest';
import { bytesToBase64Url, decryptToken, encryptToken } from './token-crypto.js';

const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

describe('token encryption', () => {
  it('round-trips and never reuses an IV', async () => {
    const first = await encryptToken('secret-token', KEY);
    const second = await encryptToken('secret-token', KEY);
    expect(first).not.toBe(second);
    expect(first.startsWith('v1:')).toBe(true);
    expect(first).not.toContain('secret-token');
    expect(await decryptToken(first, KEY)).toBe('secret-token');
    expect(await decryptToken(second, KEY)).toBe('secret-token');
  });

  it('rejects a tampered ciphertext and an unknown format', async () => {
    const stored = await encryptToken('secret', KEY);
    const [version, iv, ciphertext] = stored.split(':');
    const flipped = ciphertext.startsWith('A')
      ? `B${ciphertext.slice(1)}`
      : `A${ciphertext.slice(1)}`;
    await expect(decryptToken(`${version}:${iv}:${flipped}`, KEY)).rejects.toThrow();
    await expect(decryptToken('plain-text', KEY)).rejects.toThrow('Unrecognized token ciphertext');
  });

  it('refuses a key that is not 32 bytes', async () => {
    await expect(encryptToken('secret', btoa('short'))).rejects.toThrow('32 bytes');
  });

  it('refuses to decrypt under a different key', async () => {
    const other = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => 7)));
    const stored = await encryptToken('secret', KEY);
    await expect(decryptToken(stored, other)).rejects.toThrow();
  });

  it('encodes URL-safe base64 without padding', () => {
    expect(bytesToBase64Url(new Uint8Array([251, 255, 254]))).toBe('-__-');
  });
});
