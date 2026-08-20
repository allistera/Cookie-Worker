const encoder = new TextEncoder();

/**
 * Builds a deterministic Message-ID for inbound mail that lacks one.
 *
 * @param {{from?: string | null, to?: string | null, date?: string | null, subject?: string | null, bodyPrefix?: string | null}} parts
 * @returns {Promise<string>}
 */
export async function syntheticMessageId(parts) {
  const joined = [parts.from, parts.to, parts.date, parts.subject, parts.bodyPrefix]
    .map((value) => value ?? '')
    .join('|');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(joined));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `<synthetic-${hex}@mail-app-ingest>`;
}
