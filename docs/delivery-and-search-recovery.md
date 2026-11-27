# Delivery and search recovery

Apply migrations 0103 and 0104 before deploying the updated send
Worker. The send API requires its delivery ledger; it fails closed if the
migration is missing. Vercel's `/api/send` delegates delivery to this Worker.

Every immediate or scheduled delivery records its identity, frozen provider
payload and sent-copy metadata before contacting Resend. The first attempt
starts a fixed 23-hour retry window, shorter than
[Resend's 24-hour idempotency retention](https://resend.com/docs/dashboard/emails/idempotency-keys).
Retries retain the key and payload. At most five ambiguous attempts are made.
An attempt that stopped before the provider was called (an attachment that
could not be read, or a busy payload slot) is given back and does not count.
An active two-minute lease prevents concurrent provider requests. A known
provider receipt is always handled as local sent-copy repair, even after the
retry window.

The send Worker's 15-minute cron repairs up to five deliveries per invocation,
with a separate budget of 25 provider/attachment requests. It cannot resend a
delivery whose uncertainty window has ended. Accepted deliveries keep their
metadata until their sent copy is stored. Completed and rejected records retain
only the identity/receipt metadata needed to reject duplicate requests; message
content is removed from those ledger records. Account deletion cascades the
ledger.

The API returns `sentCopyPending: true` when Resend accepted the message but
local history still needs repair. The browser keeps the frozen request in its
account-scoped local recovery store until delivery is confirmed.

## Send error contract

Every failure of `POST /send`, immediate or scheduled, is in this table. The
coded rows are also `SEND_ERROR_CONTRACT` in
`workers/cookie-web-send/src/sendErrorContract.js`, which sets their status,
and `sendErrorContract.test.js` checks both. "Release" means the client frees
the request id so the draft can be edited and sent anew. "Retry" keeps the
draft locked and retries the same unchanged request. "Surface" keeps it locked
and shows the error without retrying.

| Code                            | HTTP status                                                                                  | Meaning                                                                                                                              | May have been sent                                                    | Client                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------- |
| `DELIVERY_REJECTED`             | 422                                                                                          | The provider refused this exact message; resending it unchanged is refused again.                                                    | No                                                                    | Release                                     |
| `DELIVERY_NOT_SENT`             | 503, `Retry-After: 5`                                                                        | The delivery is recorded but stopped before the provider was called (an attachment could not be read, or the payload slot was busy). | No, but the recorded delivery can still go out on a retry or the cron | Retry                                       |
| `DELIVERY_PENDING`              | 503, `Retry-After: 5`; 502 from the Vercel `/api/send` proxy when the Worker does not answer | Another attempt holds the lease, or the provider gave no clear answer.                                                               | Maybe                                                                 | Retry                                       |
| `DELIVERY_UNCERTAIN`            | 409                                                                                          | Five attempts or the 23-hour window passed without a provider answer. Needs operator or recipient confirmation.                      | Maybe                                                                 | Surface; never retry with a new request id  |
| `DELIVERY_CONFLICT`             | 409                                                                                          | The request id was already used for different content.                                                                               | An earlier email under that id may have been                          | Surface                                     |
| `DELIVERY_REQUEST_ID_REQUIRED`  | 409                                                                                          | A request without a request id matches a completed send older than 24 hours.                                                         | The earlier one was; this one was not                                 | Release; a new email needs a new request id |
| `SEND_CONFIRMATION_REQUIRED`    | 403                                                                                          | An agent send or schedule has no valid confirmation for this request id.                                                             | No                                                                    | Release                                     |
| `SEND_CONFIRMATION_UNAVAILABLE` | 503                                                                                          | The confirmation table is missing (migration not applied).                                                                           | No                                                                    | Retry later                                 |
| none                            | 400                                                                                          | Invalid JSON, recipients, subject or body, `attachmentIds`, `sendAt` or `followUpAt`, or attachments over the size limit.            | No                                                                    | Release                                     |
| none                            | 401                                                                                          | Missing or invalid access token.                                                                                                     | No                                                                    | Release                                     |
| none                            | 403                                                                                          | Mailbox access is not provisioned.                                                                                                   | No                                                                    | Release                                     |
| none                            | 404                                                                                          | Reply target or attachment not found.                                                                                                | No                                                                    | Release                                     |
| none                            | 413 or 415                                                                                   | Body over 4.5 MB, or not JSON.                                                                                                       | No                                                                    | Release                                     |
| none                            | 429                                                                                          | Per-minute quota (10), daily cap (300), or 50 pending scheduled sends.                                                               | No                                                                    | Release                                     |
| none                            | 500                                                                                          | Unexpected failure while scheduling or before delivery.                                                                              | No for a schedule; a recorded immediate delivery resumes on retry     | Retry                                       |
| none                            | 502                                                                                          | Unexpected failure in the delivery step outside the coded outcomes.                                                                  | Unlikely; a recorded delivery resumes on retry                        | Retry                                       |
| none                            | 503                                                                                          | Sending is not configured, or the quota check failed.                                                                                | No                                                                    | Retry                                       |

Only `DELIVERY_PENDING` and `DELIVERY_NOT_SENT` carry `Retry-After`. The 409
codes must not be retried automatically, so they have none. The scheduled-send
flush (`POST /send/flush`, cron only) maps the same codes onto the row:
`DELIVERY_NOT_SENT` and `DELIVERY_PENDING` leave it `pending`,
`DELIVERY_REJECTED` marks it `failed`, and `DELIVERY_UNCERTAIN` or
`DELIVERY_CONFLICT` mark it `uncertain`.

## Request ids and recovery

The MCP `cookie_send_email` tool requires a caller-supplied `requestId`, reused
for every retry and changed only for an intentional new message, and a
`confirmation` the owner created in Cookie for that email (README, "Agent send
confirmations"); without it the send answers 403 `SEND_CONFIRMATION_REQUIRED`. Older direct
API clients may omit it for a first send and replay the same completed receipt
within the original 24-hour window. After that window, a completed immediate
delivery without an explicit identity returns HTTP 409 with
`DELIVERY_REQUEST_ID_REQUIRED`; a new intended email requires a new request ID.
The server neither silently replays the old success nor invents a new send.
Unresolved accepted deliveries still repair their original copy, while
uncertain deliveries still require confirmation.

Scheduled retries use the original `requestId`, payload and `sendAt`. A matching
request returns HTTP 200 with the existing `scheduledSend`, even after its send
or reminder time has passed or its source upload has been cleaned up. Its
`status` is `pending`, `sending`, `sent`, `failed` or `uncertain`, and `lastError`
describes a recorded failure. This lookup never dispatches mail or rearms the
clock. Changed content returns HTTP 409 with `DELIVERY_CONFLICT`. New schedules
still require a future time and return HTTP 201; a missing original request
with a past send time cannot create a replacement schedule.

Migration 0104 conservatively marks legacy leased or previously attempted
scheduled messages uncertain, including exhausted failures, because their first provider attempt is unknown.
Inspect those entries before any manual resend. To investigate an uncertainty,
use the source key and Resend dashboard/provider id and confirm the actual
delivery with the owner. Do not record private message payloads in logs or
support tickets. An operator-confirmed provider receipt can be recorded in the
ledger and set to `accepted` for the next cron to repair its copy; any decision
to send a new copy needs the owner's explicit confirmation.

Monitor the counts and oldest `updated_at` of `pending`, `sending`, `accepted`
and `uncertain` rows. `accepted` entries remaining after consecutive cron
passes indicate a database, attachment metadata, or sent-copy constraint issue.
`outbound_delivery_confirmation_pending` and `outbound_sent_copy_pending` logs
contain no payload or credentials.

## Search repair

Document and task search repair runs on the ingest Worker at minutes 7, 22, 37
and 52. Each tick handles at most 25 oldest changed documents and 25 root tasks,
including changed child task text. It uses the same selectors as the repair CLI.
Only a successfully completed Meilisearch task can stamp rows as indexed, and
row/child versions must still match. One failed target does not block the other.
This cron has its own subrequest budget, separate from the existing inbound
enrichment and message-search cron.

While waiting for an accepted Meilisearch write, transient gateway or transport
failures retry the status lookup for the same task within the existing
20-second polling deadline. This includes Cloudflare's plain-text gateway
responses that the SDK exposes as JSON parsing errors. A failed/canceled task,
a permanent API rejection, or unrelated malformed JSON still fails immediately.
A prolonged outage leaves the rows unstamped for a later repair pass.

Track `workspace_search_drift_swept` by target and `oldest_age_seconds`, plus
`workspace_search_drift_failed`. A continuously growing oldest age calls for
checking Meilisearch task failures and the incoming edit rate before increasing
the bounded batch size. The weekly repair workflow remains a backstop.
Failed batches record only their target and document IDs, never content. A
permanently invalid document can keep its oldest batch dirty; inspect the
Meilisearch failed-task error for those IDs and correct the source record or
index settings before replaying the repair. The other target continues to run.
