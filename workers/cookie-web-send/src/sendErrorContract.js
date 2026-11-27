// The coded failures of POST /send and what a client does with the draft.
// docs/delivery-and-search-recovery.md has the same table, together with the
// uncoded validation, quota and configuration answers.
//
// sent: whether the email may have gone out ('no', 'maybe', or 'earlier' when
// an earlier email under the same request id was sent).
// client: 'release' frees the request id so the draft can be edited and sent
// anew; 'retry' keeps the draft locked and retries the same unchanged request;
// 'surface' keeps it locked and shows the error without retrying.

/**
 * @typedef {object} SendErrorContractEntry
 * @property {number} status
 * @property {string | null} retryAfter Retry-After header value, if any.
 * @property {'no' | 'maybe' | 'earlier'} sent
 * @property {'release' | 'retry' | 'surface'} client
 */

/** @type {Readonly<Record<string, SendErrorContractEntry>>} */
export const SEND_ERROR_CONTRACT = Object.freeze({
  DELIVERY_REJECTED: { status: 422, retryAfter: null, sent: 'no', client: 'release' },
  DELIVERY_NOT_SENT: { status: 503, retryAfter: '5', sent: 'no', client: 'retry' },
  DELIVERY_PENDING: { status: 503, retryAfter: '5', sent: 'maybe', client: 'retry' },
  DELIVERY_UNCERTAIN: { status: 409, retryAfter: null, sent: 'maybe', client: 'surface' },
  DELIVERY_CONFLICT: { status: 409, retryAfter: null, sent: 'earlier', client: 'surface' },
  DELIVERY_REQUEST_ID_REQUIRED: {
    status: 409,
    retryAfter: null,
    sent: 'earlier',
    client: 'release',
  },
  SEND_CONFIRMATION_REQUIRED: { status: 403, retryAfter: null, sent: 'no', client: 'release' },
  SEND_CONFIRMATION_UNAVAILABLE: { status: 503, retryAfter: null, sent: 'no', client: 'retry' },
});

/**
 * Builds the JSON error response the contract gives `code`.
 *
 * @param {string} code
 * @param {string} error
 */
export function sendErrorResponse(code, error) {
  // An unlisted delivery code is treated as still being confirmed.
  const { status, retryAfter } = SEND_ERROR_CONTRACT[code] ?? SEND_ERROR_CONTRACT.DELIVERY_PENDING;
  return Response.json(
    { error, code },
    retryAfter ? { status, headers: { 'Retry-After': retryAfter } } : { status },
  );
}
