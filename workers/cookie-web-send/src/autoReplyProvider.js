export const AUTO_REPLY_PROVIDER_TIMEOUT_MS = 10_000;

/**
 * Resend's SDK does not expose an AbortSignal for send. This small, fixed-origin
 * adapter bounds the owner lock and uses the same delivery credential. Neither
 * provider response bodies nor incoming/private content enter logs or errors.
 * @param {Record<string, any>} payload
 * @param {string} idempotencyKey
 * @param {string | undefined} apiKey
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 */
export async function sendAutoReply(
  payload,
  idempotencyKey,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = AUTO_REPLY_PROVIDER_TIMEOUT_MS,
) {
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1, Math.min(AUTO_REPLY_PROVIDER_TIMEOUT_MS, timeoutMs))),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && typeof body?.id === 'string' && body.id)
      return { status: 'sent', providerId: body.id };
    // Only a definite first-attempt rejection can be called failed. The caller
    // treats a rejection after an earlier ambiguous attempt as uncertain.
    if (
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 409, 429].includes(response.status)
    )
      return { status: 'rejected', providerId: null };
    if (body?.name === 'invalid_idempotent_request')
      return { status: 'uncertain', providerId: null };
    return { status: 'retry', providerId: null };
  } catch {
    return { status: 'retry', providerId: null };
  }
}
