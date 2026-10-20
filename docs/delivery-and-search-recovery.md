# Delivery and search recovery

Apply Cookie-Web migrations 0103 and 0104 before deploying the updated send
Worker. The send API requires its delivery ledger; it fails closed if the
migration is missing. Vercel's `/api/send` delegates delivery to this Worker.

Every immediate or scheduled delivery records its identity, frozen provider
payload and sent-copy metadata before contacting Resend. The first attempt
starts a fixed 23-hour retry window, shorter than
[Resend's 24-hour idempotency retention](https://resend.com/docs/dashboard/emails/idempotency-keys).
Retries retain the key and payload. At most five ambiguous attempts are made.
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
local history still needs repair. `DELIVERY_PENDING` permits retrying the same
unchanged request. `DELIVERY_UNCERTAIN` requires operator or recipient
confirmation; never clear its deadline or generate a new request id as an
automatic retry. `DELIVERY_CONFLICT` means a client reused an identity for
different content. The browser keeps the frozen request in its account-scoped
local recovery store until delivery is confirmed.

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

Document and task search repair runs on the ingest Worker at minutes 7, 22, 37
and 52. Each tick handles at most 25 oldest changed documents and 25 root tasks,
including changed child task text. It uses the same selectors as the repair CLI.
Only a successfully completed Meilisearch task can stamp rows as indexed, and
row/child versions must still match. One failed target does not block the other.
This cron has its own subrequest budget, separate from the existing inbound
enrichment and message-search cron.

Track `workspace_search_drift_swept` by target and `oldest_age_seconds`, plus
`workspace_search_drift_failed`. A continuously growing oldest age calls for
checking Meilisearch task failures and the incoming edit rate before increasing
the bounded batch size. The weekly repair workflow remains a backstop.
Failed batches record only their target and document IDs, never content. A
permanently invalid document can keep its oldest batch dirty; inspect the
Meilisearch failed-task error for those IDs and correct the source record or
index settings before replaying the repair. The other target continues to run.
