# Database migrations

Cookie uses append-only SQL migrations against Supabase Postgres. The same schema supports Cookie-Web and Cookie-Worker. The migrations lived in Cookie-Web until November 2026; the earlier history of each file is in that repository.

## Conventions

- Files use ordered names such as `0010_ai_enrichment.sql`.
- Every migration is transactional. Write the wrapper as bare column-0
  `BEGIN;` and `COMMIT;` lines; `migrate.sh` strips them and runs the file
  and its `schema_migrations` marker in one transaction, and refuses files
  with any other top-level transaction control (`begin;`, `COMMIT WORK;`,
  `ROLLBACK;`, ...).
- Applied filenames are stored in `schema_migrations`.
- Never change an applied migration; add a new file instead.
- Runtime code must remain compatible until its required migration is applied.

## Apply pending migrations

Set an IPv4-reachable Supabase pooler connection in `DATABASE_URL`, then run:

```sh
./migrations/migrate.sh
```

The script creates `schema_migrations` if needed, applies pending files in order, and safely skips files already recorded.

Pushes to `main` that change `migrations/**` run the same script through the `Migrate Database` GitHub Actions workflow.

Each file runs with `lock_timeout = '5s'` and `statement_timeout = '5min'`,
set after the runner's advisory lock. A migration that needs longer can raise
either with `SET LOCAL` at the top of its body. For an index on a large hot
table, build it by hand first with `CREATE INDEX CONCURRENTLY` outside a
transaction, then let the migration's `CREATE INDEX IF NOT EXISTS` no-op; the
header comment in `migrate.sh` has the steps.

## Connection guidance

Use the Supavisor session pooler on port `5432` for GitHub-hosted migrations. GitHub runners cannot depend on an IPv6-only direct database host. The runner drops the `supa` parameter that Supabase's dashboard adds to its pooler strings, because `psql` rejects it.

Use a development project for local migration testing. Do not point routine local commands at production.

## Private inbox broadcast migration (0105)

Supabase owns `realtime.messages` and enables its row level security by default.
The migration role can manage policies on that table but cannot run `ALTER TABLE`
on it. Migration `0105_private_inbox_broadcasts.sql` checks the existing RLS flag
and creates the owner-scoped receive policy without changing the managed table.
See [Supabase's ownership-error guidance](https://supabase.com/docs/guides/troubleshooting/realtime-must-be-owner-of-table-messages).

The ownership failure rolls back the entire migration and its tracking row.
The correction to this failed, unrecorded migration lets the normal workflow
retry it; a later migration could not unblock an earlier failure. Environments
that already recorded `0105` continue to skip it. No credential or ownership
change is required. If the RLS prerequisite is missing, the migration fails
rather than installing an unenforced policy.

## AI enrichment migrations

`0010_ai_enrichment.sql` adds per-label auto-tag settings, model-label provenance, and durable `message_ai` enrichment state.

Apply `0010` before deploying Cookie-Worker code that creates pending enrichment rows during inbound storage.

`0011_backfill_ai_pending.sql` queues existing inbound messages. Cookie-Worker's 15-minute recovery sweep processes three stale pending or failed rows per run.

AI failure state is recoverable and never changes the mail-forwarding outcome. Only spam scores of at least `0.98` are excluded from Inbox.

## Done timestamp for email triage

`0092_message_archived_at.sql` adds `messages.archived_at`, stamped by a
`BEFORE INSERT OR UPDATE OF is_archived` trigger when a message is marked
done and cleared when it returns to the inbox, plus a partial index on
`(user_id, archived_at DESC)`. Cookie-Worker's `data-enricher` uses it to
include mail marked done within the last 24 hours in AI Today's email triage,
and `cookie-web-tasks` keeps those rows (shown as done) instead of dropping
them. Mail done before the migration has no stamp and stays out of that
window. Apply this migration before deploying `data-enricher` and
`cookie-web-tasks`; the Cookie-Web view only reads the `done` flag they
return.

## Private calendar feeds

`0101_calendar_feeds.sql` creates the server-only `calendar_feeds` table.
Each native calendar can have one active token; only its SHA-256 digest is
stored. The composite foreign key binds it to the calendar's owner and deletes
it when the calendar is deleted. Generation/replacement and revocation use
the calendar Worker's authenticated `/calendar-feeds` endpoint; subscribers
use `GET /calendar-feed.ics?token=…` without a Cookie session.

Apply the migration, deploy the matching `cookie-web-calendar` Worker, then
use Settings → Calendars → Private calendar feeds in Cookie-Web. While the
migration or Worker is pending, feed controls report an unavailable status
and ordinary calendar management remains usable. No links are enabled by
this migration.

## Google Calendar

`0091_google_calendar.sql` adds `google_calendar_connections` (one row per
user: the Google OAuth refresh and access tokens, AES-256-GCM encrypted under
the `cookie-web-calendar` Worker's `GOOGLE_TOKEN_ENCRYPTION_KEY` secret, the
account email, and a snapshot of the Google calendars chosen to show in
Cookie) and `google_calendar_oauth_states` (the single-use state of a sign-in
in progress, bound to the user who started it, since Google's redirect back
to the Worker carries no bearer token). Nothing from Google is mirrored into
`calendar_events`; events are read live per window and written straight back
to Google. Both tables are server-only. Apply this migration before deploying
`cookie-web-calendar` with its Google secrets, then deploy Cookie-Web for the
Settings → Calendars → Google Calendar section; without the migration the
Worker reads "not connected" and the rest of the Calendar app is unaffected.

## Browser notification events

`0071_thread_muting.sql` adds persistent conversation muting on `threads.is_muted`.
Muted replies still refresh the inbox but do not create browser notification events.
The messages Worker exposes `mute_thread` / `unmute_thread` actions and removes pending
alerts on mute; the notifications Worker also checks mute status when claiming an alert.
Apply this migration before deploying `cookie-web-messages` and `cookie-web-notifications`,
then deploy Cookie-Web for the reader's Mute thread / Unmute thread control.

`0016_browser_notification_events.sql` adds short-lived, opaque event tokens for opt-in browser notifications. Realtime broadcasts only the token; an authenticated Vercel function leases and resolves its owned message before the browser can display sender and subject. The table is server-only, old unclaimed events are pruned after 24 hours, and all notification failures remain isolated from inbound message ingestion.

`0077_ntfy_notifications.sql` adds opt-in ntfy subscriptions and a separate
short-lived delivery queue. The notifications Worker drains that queue every
minute and publishes only a sender label, subject, and Cookie deep link; the
database trigger keeps ntfy delivery isolated from inbound message ingestion.

`0078_category_notifications.sql` adds the default-on notification preference
for each email category. Apply it before deploying the category API and
notifications Worker changes that read `email_categories.notifications_enabled`.
Both browser and ntfy delivery wait for pending enrichment, then suppress an
alert when its assigned category has notifications disabled.

`0110_ntfy_user_servers.sql` adds the per-user ntfy server URL, an encrypted
access token and its display hint to `ntfy_subscriptions`, backfilling the
default server for existing rows, and replaces the global topic uniqueness
with uniqueness per server. Apply it before deploying the
`cookie-web-notifications` Worker that saves the Settings form, then deploy
Cookie-Web.

## Read receipts

`0021_read_receipts.sql` stores opaque per-message tokens and best-effort open timestamps for sent mail. The tracking pixel contains no mailbox or message identifier, the receipt table is server-only, and stored sent HTML excludes the pixel so opening Cookie's own sent copy does not mark it read. Image blocking can suppress receipts and security scanners can trigger them, so the UI treats status as indicative rather than guaranteed.

`0028_security_boundaries.sql` expires receipt capabilities after 90 days,
deduplicates rapid receipt opens in the API, and adds the server-only durable
per-user quota row used to bound outbound mail across function instances.

`0039_api_rate_limits.sql` adds server-only, durable per-user counters for AI
and enricher requests. The AI endpoints share one scope, so switching routes
or serverless instances cannot multiply the configured allowance.

## Label rules

`0029_label_rules.sql` adds `label_rules` and `label_rule_conditions` for deterministic, user-defined tagging (subject/body/from/to conditions, matched with `contains`/`equals`/`starts_with`/`ends_with`, combined with `all`/`any`). Cookie-Worker evaluates enabled rules inside the same transaction that stores an inbound message and writes matches to `message_labels` with `source = 'rule'` and the new `rule_id` provenance column. Unlike AI auto-tagging, rule matching is synchronous and has no recovery cron because it never leaves the message's own storage transaction.

`0068_ai_label_rules.sql` adds `kind` (`conditions`/`ai`) and `prompt` to `label_rules`. A `kind = 'ai'` rule is defined by a plain-language prompt instead of conditions; Cookie-Worker's `mail-app-ingest` hands enabled prompts to the same classification call that auto-tags by label description and applies the rule's action above the shared 0.7 confidence bar, writing labels with `source = 'ai'` and `rule_id` provenance. Apply `0068` before deploying the `cookie-web-labels` and `mail-app-ingest` Workers that read the new columns.

Apply `0029` before deploying Cookie-Worker code that reads `label_rules`.

`0030_rule_actions.sql` adds `label_rules.action` (`apply_label` or `mark_done`) and makes `label_id` nullable, so a rule can mark matching mail done (`is_archived`/`is_unread`, the same state the "Marked done" archive flow sets) instead of only applying a label. A CHECK keeps `label_id` required for `apply_label` and null for `mark_done`.

Apply `0030` before deploying Cookie-Worker code that reads `label_rules.action`.

## Scheduled sends

`0032_scheduled_sends.sql` adds `scheduled_sends` for "Send Later": a composed
message queued for a future `scheduled_for` instead of sending immediately.
Unlike inbound snooze (`0012_scheduled_messages.sql`), where a due message
just becomes visible again the next time it's queried, sending mail is an
active operation — so a Cloudflare Worker cron in Cookie-Worker polls
`POST /api/send?resource=flush` on an interval, and that endpoint claims due
rows, calls the mail provider, and files the result back onto `messages` the
same way an immediate send does.

Apply `0032` before deploying the Cookie-Worker `scheduled-send-flusher`
worker, since its flush calls will 404/error against an API that doesn't yet
recognize `resource=scheduled`/`resource=flush`.

## Calendar auto-scheduled

`0033_calendar_auto_scheduled.sql` adds `calendar_events.is_auto_scheduled`
(default `false`) so the Calendar view's "Auto-scheduled" insight card can
report a real count instead of hardcoded copy. No feature sets this column to
`true` yet, so the card reads 0 until an actual auto-scheduling feature
exists — this migration is plumbing ahead of that feature, not the feature
itself.

## Query indexes

`0041_calendar_events_recurring_index.sql` adds a partial index on
`calendar_events (user_id) WHERE recurrence_rule IS NOT NULL`. Every calendar
load unconditionally includes recurring masters regardless of the requested
range (a series row's `event_date` is only its start), and this branch wasn't
covered by `calendar_events_user_date_idx`.

`0042_recipients_trgm_index.sql` adds a `pg_trgm` GIN index on
`(recipients::text)` so the `to:` search operator's `ILIKE '%...%'` predicate
(api/_lib/retrieval.js) can use an index. The full-text `search` tsvector
(0017) can't substitute here: its parser tokenizes each email address as one
lexeme, so it can't match a partial address the way `to:` currently does.

`0043_message_labels_rule_index.sql` adds a partial index on
`message_labels (rule_id) WHERE rule_id IS NOT NULL`. Deleting a label rule
sets it `NULL` on every referencing row (`ON DELETE SET NULL`), and
`message_labels` is the largest, continuously-growing table in the schema.

`0044_scheduled_sends_and_receipts_cleanup_indexes.sql` adds a
`scheduled_sends (user_id, scheduled_for) WHERE status = 'failed'` index
matching `listScheduledSends`'s `status IN ('pending', 'failed')` read (only
the `'pending'` half had index support before), and a
`message_read_receipts (expires_at)` index supporting the new periodic sweep
of expired receipts and resolved scheduled sends that
`POST /api/send?resource=flush` now performs after each batch — the flush job
is the only periodic cron trigger this app has, so both tables' cleanup piggybacks
on it instead of adding a new endpoint.

`0045_message_fk_indexes.sql` adds indexes on `tasks.message_id`,
`summaries.message_id`, `scheduled_sends.reply_to_message_id`, and
`scheduled_sends.sent_message_id` — FK columns referencing `messages(id)`
with no index of their own. The app only soft-deletes messages today, so
this is insurance against a future hard-delete/purge path triggering an
unindexed cascade scan, not an active hot path.

`0047_daily_note_calendar_events.sql` adds `calendar_events.source_document_id`
/ `source_block_id` and a partial unique index on the pair, so a typed
time-range line in a Daily note maps to exactly one event and repeat saves
upsert it (`ON CONFLICT (source_document_id, source_block_id)`) instead of
creating duplicates. `source_document_id` is `ON DELETE SET NULL`, not
`CASCADE` — deleting the note detaches its events rather than deleting real
calendar commitments along with it.

`0052_follow_up_reminders.sql` adds optional follow-up timestamps to sent
messages and pending scheduled sends. A partial due-reminder index supports
Inbox resurfacing without scanning ordinary sent mail.

## Task priority

`0058_task_items_priority.sql` adds `task_items.priority` (`smallint NOT NULL
DEFAULT 4`, checked to `1..4`), Todoist-style: 1 is the most urgent, 4 is the
default and reads as "no priority" in the Tasks app. The column is not
nullable — every task has a priority, and "unset" is just the lowest level.

Apply `0058` before deploying Cookie-Worker code that reads or writes
`task_items.priority`; the `cookie-web-tasks` Worker selects and returns the
column on every task read.

## Todoist sync switches

`0094_todoist_sync_options.sql` adds `todoist_connections.sync_projects` and
`sync_tasks` (both `boolean NOT NULL DEFAULT true`), the two checkboxes under
Settings > Tasks > Todoist that choose whether a run mirrors the account's
projects, its tasks, or both. Every existing connection keeps doing both.

`0095_todoist_tasks_synced_at.sql` adds `tasks_synced_at`, the completion
cursor (the last run that read tasks), backfilled from `last_synced_at`,
which stays the last successful run of any kind. A projects-only run leaves
the cursor where it was.

Apply `0094` and `0095` before deploying the `cookie-web-tasks` Worker that
reads the columns on every connection read.

## Forwarded attachments

`0059_scheduled_send_attachments.sql` stores ownership-checked attachment
references for pending outbound messages. This lets Send Later carry private
attachments without exposing Blob URLs or file bytes to the browser; rows are
removed automatically with their scheduled send.

Apply `0059` before enabling forwarded attachments. During a rolling deploy,
both send handlers fall back to attachment-free cancel/flush queries so mail
already queued by the previous release keeps working until the table exists.

## Composer uploads

`0060_outbound_attachments.sql` adds `outbound_attachments`, the home for files
picked in the composer or reply box. Inbound attachments are owned through
their message (`attachments.message_id` is `NOT NULL`), which leaves a draft's
uploads nowhere to live until the send that consumes them; this table owns them
by `user_id` instead.

Bytes never pass through the Vercel function: the browser gets a short-lived
Blob client token scoped to `outbound-attachments/<user_id>/` and uploads
directly, because a proxied upload would be capped at Vercel's ~4.5 MB request
body limit — well under the 20 MB `MAX_OUTBOUND_ATTACHMENT_BYTES` ceiling. The
registration call re-derives ownership from the stored pathname and records the
size `head()` reports, so a client cannot claim another account's blob or
misstate what it uploaded.

The migration also widens `scheduled_send_attachments` (0059) to reference
either source: `attachment_id` becomes nullable, `outbound_attachment_id` is
added, and a CHECK keeps exactly one of the two set. 0059's primary key is
replaced by one partial unique index per source plus a plain
`(scheduled_send_id)` index, since neither partial index alone covers a mixed
row set.

Apply `0060` before deploying code that records composer uploads (today
`POST /send/attachments` on the `cookie-web-send` Worker).
Both the send and cancel paths fall back to forwarded-attachment-only queries
while the table is missing, so a rolling deploy keeps existing mail working.

Abandoned uploads are swept by `POST /api/send?resource=flush` after each
batch, alongside the resolved scheduled sends and expired receipts it already
cleans up. A row is only eligible once it is a day old, is referenced by no
pending scheduled send, and shares its `blob_url` with no `attachments` row —
a sent copy records the same blob, and deleting those bytes would empty an
attachment the user can still open in their sent mail.

## Drafts

`0061_drafts.sql` adds `drafts` and `draft_attachments`, backing composer
autosave and the Drafts view. Before this, the only outbound state that
survived a reload was the undo-send holding row in `scheduled_sends`; a
half-written message lived in the browser tab and died with it.

Drafts are deliberately not `messages` rows. `messages` requires
`from_address`, `recipients`, `thread_id` and `sent_at`, carries the search
tsvector and thread counters, and is append-only in practice. A draft is empty
when it is created, has none of those, and is rewritten every few seconds
while someone types.

`draft_attachments` uses the same two-source shape as
`scheduled_send_attachments`: `attachment_id` for a forwarded inbound file,
`outbound_attachment_id` for a composer upload, with a CHECK keeping exactly
one set. Ownership is re-resolved on every save, so an id the user does not
own is dropped rather than stored.

The orphaned-upload sweep in `POST /api/send?resource=flush` now also spares
any upload a draft references (see 0060). A draft can sit untouched for weeks,
well past the 24-hour retention window, and its files must outlive it.

Apply `0061` before deploying the `cookie-web-drafts` Worker (Cookie-Worker
repo), which serves `GET /drafts`, `POST /drafts`, and
`GET/PATCH/DELETE /drafts/:id`.

## Out-of-office replies

`0082_out_of_office.sql` snapshots the enabled responder revision on new inbound
messages and adds private delivery/cooldown tables. Existing mail has no snapshot
and can never be revived by enabling or editing the responder. The snapshot
trigger fails closed without failing mail storage. `auto_reply_suppressed` is the
integration seam for future screening/blocking: set it before a decision becomes
visible; the send Worker checks it again before dispatch.

Publish this migration alone and await **Migrate Database** success before
deploying the emails/send Workers (and the compatible ingest Worker), then publish
the Web settings and Docs. The migration does not enable any account. The new
tables have RLS, no browser-role privileges, and explicit server-role access.
Worker APIs resolve Auth0 subjects through `users.auth0_sub`; these tables do not
use Supabase Auth UUID assumptions.

Delivery uses a stable provider key and immutable payload. Retry stops after 23
hours, before Resend's 24-hour key expiry; uncertain outcomes require explicit
owner review. Do not delete unresolved delivery/cooldown records or retry them
manually at the provider. See the Worker component documentation for recovery.

## Historical migration

The production database moved from Neon to Supabase in July 2026. [`supabase-cutover.md`](supabase-cutover.md) is retained as a historical record, not a current runbook.

## Recurring tasks

`0066_task_items_recurrence.sql` adds nullable `task_items.recurrence`, with a
constraint requiring a due date and task kind whenever recurrence is set.
Existing tasks remain non-recurring. Apply this migration before deploying
Cookie-Worker's updated task API, then deploy Cookie-Web.

## Natural-language task metadata

`0067_task_items_time_and_labels.sql` adds nullable `due_time` and `time_zone`
columns plus a non-null `labels` text array. A due time must have both a due
date and time zone; dividers cannot carry times or labels. Existing tasks keep
no due time and an empty label list. Apply this migration before deploying the
task API that reads and writes these fields.

## Task labels

`0079_task_labels.sql` adds `task_labels`, one row per user-defined label
with a colour, keyed by `(user_id, name)`. `task_items.labels` keeps holding
names; this table is what the Tasks sidebar lists and what a rename or
delete rewrites across tasks. It seeds a row for every name already on a
task and adds a GIN index on `task_items.labels` for the label view's
containment filter. Apply it before deploying the `cookie-web-tasks` Worker
that serves `/task-labels`, then deploy Cookie-Web.

## Automatic priority reply drafts

`0069_priority_reply_drafts.sql` adds independent reply-draft status, attempts,
and a lease timestamp to `message_ai`, plus `drafts.is_ai_generated`. Terminal
state outlives the draft, preventing regeneration after sending or discarding.
The existing Drafts permissions and RLS remain in force. A trigger sends only
a content-free inbox refresh signal after an AI draft is first inserted.
Apply before deploying `mail-app-ingest` and `cookie-web-drafts` in Cookie-Worker.

## Scheduled send retries

Apply `0070_scheduled_send_requests.sql` before deploying the updated
`cookie-web-send` Worker, then deploy Web. It adds an optional client request id
and payload hash, unique per owner, so retries of a queued send return the same
row. Reusing an id with different content returns HTTP 409. Clients without an
id keep the existing scheduling behavior. Request records follow the scheduled
row's existing cancellation and retention lifecycle.

## Live thread summaries

`0072_thread_summaries.sql` stores a one-line summary on `threads`, separately
from the per-message enrichment in `message_ai.summary`. The accompanying
message and AI Workers compare `ai_summary_message_id` with the newest live
message, so a reply immediately makes an old summary stale and the Web reader
regenerates it after the existing Realtime inbox refresh. Apply this migration
before deploying `cookie-web-ai`, `cookie-web-emails`, `cookie-web-messages`,
`cookie-web-search`, and Cookie-Web.

## Email categories

`0073_email_categories.sql` adds user-defined Category records and a nullable
`messages.category_id` foreign key. A message can therefore belong to at most
one Category; deleting a Category clears it from affected messages. Categories
remain separate from many-to-many Labels. Apply this migration before
deploying `cookie-web-labels`,
`cookie-web-emails`, `cookie-web-messages`, `cookie-web-search`, and Cookie-Web.

## Auto Archive removal

`0111_drop_auto_archive_prefs.sql` removes the `autoArchive` key from
`users.prefs`. The opt-in Auto Archive categories were replaced by Rules with
the "Mark done" action, and no Worker or Cookie-Web code reads the key any
more, so the migration can be applied before or after those deploys.

## Outbound attachment uniqueness

`0083_outbound_attachments_unique.sql` merges duplicate `outbound_attachments`
rows for the same `(user_id, blob_url)`, repointing draft and scheduled-send
references to the oldest row, then adds a unique index on that pair. Composer
upload registration uses it to upsert, so a retried registration returns the
existing row instead of adding a copy. Web works before and after this
migration: without the index, registration falls back to a plain insert.

## Missing indexes

`0084_missing_indexes.sql` adds indexes for the orphaned-upload `blob_url`
probe, the `draft_attachments` and `task_projects` cascades, per-user deletes
of notification events, and the sender block/screening match on
`lower(btrim(from_address))`. It is safe to apply at any time.

## Enrichment attempt limit

`0085_message_ai_enrichment_attempts.sql` adds `message_ai.enrichment_attempts`.
Apply it before deploying the `mail-app-ingest` Worker version whose recovery
sweep and failure upsert read and increment that column; older Worker code
ignores it.

## Document revision trigger hardening

`0086_document_workspace_revision_hardening.sql` pins the `0075` trigger
function's `search_path`, schema-qualifies its names, and revokes client-role
access to `document_workspace_revisions`. Behaviour is unchanged.

## Sender importance feedback

`0087_sender_importance_feedback.sql` adds `sender_importance_feedback`, one
row per sender (stored as `lower(btrim(from_address))`) that the owner marked
"Not important" from the reader. Apply it before deploying the
`cookie-web-messages` and `mail-app-ingest` Workers that read and write it;
Cookie-Web's "Not important" menu item needs those Workers deployed.

## Sender screening

`0088_sender_screening.sql` adds the server-only `sender_decisions` table
(exact lowercased sender addresses, `accepted` or `blocked`), the
`messages.screening_status` disposition (`allowed`, `held`, `blocked`;
existing rows are `allowed`), and the insert trigger that assigns it before
notification events are queued. Screening stays off unless
`users.prefs.senderScreening` is `true`. It was developed as `0083` on the
sender-screening branch and renumbered on merge because `0083` was already
taken on main. Deploy the Workers in the order Cookie-Docs gives before
relying on the Web sender controls.

## Sender domain decisions

`0089_sender_domain_decisions.sql` lets a `sender_decisions` row hold `@domain`,
covering that domain and its subdomains, and adds
`effective_sender_decision(user_id, from_address)` to resolve which decision
applies (exact address first, then the longest matching domain). The arrival
trigger uses it. Apply this migration before deploying `cookie-web-emails` and
`cookie-web-notifications`, which call the function.

## Write-path cleanup

`0090_write_path_cleanup.sql` removes structures nothing reads any more and
coalesces per-row inbox pings:

- drops the generated `messages.search` and `documents.search` tsvectors
  (Meilisearch replaced them; 0081 already dropped their indexes);
- drops the 0042/0050 trigram indexes and the `pg_trgm` extension, without
  `CASCADE`, so an unexpected dependent object fails the migration instead of
  disappearing;
- drops `documents_user_updated_idx`, a strict prefix of
  `documents_workspace_page_idx`, and indexes `document_files (folder_id)` for
  the folder `ON DELETE SET NULL`;
- removes `SET search_path` from `effective_sender_decision` (its body is
  fully schema-qualified) so the planner can inline it;
- keeps the per-row INSERT inbox trigger, but replaces UPDATE and DELETE with
  statement-level triggers that send one `{"op": ...}` ping per affected user.
  A search-index restamp alone still sends nothing.

The 0075 workspace revision still bumps on `blocks`: a content save changes
`updated_at`, which the paged document listing returns and sorts by. No
deploy ordering is needed.

## Task activity and completion goals

`0097_task_activity.sql` records creation, meaningful edits (with before/after
values), completion, reopening, and deletion in a server-only `task_activity`
table. A trigger covers every database writer, including sync and cascading
project/subtask deletes. History keeps the task ID and title without a foreign
key to the task, so deleting a task preserves its history; deleting the account
removes it. No-op writes and indexing timestamps do not create activity.
Existing tasks seed only their known creation and current completion timestamps.
Past edits, deletes, reopenings, and recurring completions cannot be recovered.

`task_items.last_occurrence_completed_at` lets the Worker record a recurring
completion in the same update that advances the task's due date. Deploy the
migration first, then `cookie-web-tasks`, then the web client. Goals are stored
per account in `task_completion_goals`; zero disables a goal. Progress counts
completion events across all tasks, including recurring occurrences. Reopening
or deleting a task does not subtract previous completions. Days use the browser's
IANA time zone; weeks run Monday through Sunday, respecting daylight saving.
The task panel shows progress and a pageable timeline below comments, with
filters for the current task, completed-task history, and all activity. The Tasks
page also has a History button, available even when no active tasks remain.

The `Lint and Test` workflow runs the shipped migration against a separate disposable
Postgres service using `TASK_ACTIVITY_TEST_DATABASE_URL`. It covers backfill,
transitions, recurrence, cascades, rollback, row security, and goal constraints.

## Estimated task duration

`0098_task_duration.sql` adds nullable `task_items.duration_minutes`, a whole
number from 1 to 1440 for tasks only, and records estimate edits in task activity.
Existing tasks have no estimate. A duration does not require a date or time.
Apply the migration before deploying `cookie-web-tasks`, then deploy Cookie-Web.

### Inbox ping comparison (0108)

`0108_inbox_ping_comparison.sql` replaces body-inclusive JSON comparisons with
schema-derived metadata row comparisons and separate body comparisons. Index
stamp-only updates still skip realtime pings. Future migrations adding message
columns should regenerate this function so those fields participate too.

## Database health snapshot and slow-statement logging (0112)

`0112_db_query_stats.sql` creates `db_query_stats`, the previous reading of
`pg_stat_statements`: one row per statement with its call count and total
execution time. Cookie-Worker's `mail-app-ingest` cron compares the live
counters with it every 15 minutes to find statements that have become slower
than their own history, then replaces it. The table holds counters only, never
query text, and no API role can read it. Until the migration is applied the
Worker skips that comparison and logs `db_query_stats_unavailable`, so the two
can be deployed in either order.

The migration also sets four logging parameters on the role it runs as, which
is the role the Workers connect with:

| Setting                                 | Value     | Effect                                                    |
| --------------------------------------- | --------- | --------------------------------------------------------- |
| `log_min_duration_statement`            | `1000` ms | Statements that take a second or longer are logged        |
| `auto_explain.log_min_duration`         | `1000` ms | Their execution plan is logged too (the default was 10 s) |
| `log_parameter_max_length`              | `0`       | Bound parameter values are left out of those log lines    |
| `auto_explain.log_parameter_max_length` | `0`       | Bound parameter values are left out of the logged plans   |

The lines go to the project's own Postgres logs in Supabase. Both parameter
settings are zero so mail content and addresses bound to a slow statement are
never written there. They apply to new sessions. To undo one, run
`ALTER ROLE postgres RESET <setting>;`.

## Calendar invitations (0113)

`0113_calendar_invitations.sql` creates `calendar_invitations`: one row per
event a person was invited to by email. A row is unique on
`(user_id, uid, recurrence_id)`, the iCalendar identity of an event or of one
occurrence of a repeating event, so a revised or cancelled invitation updates
the row it belongs to instead of adding one. `sequence` and `dtstamp` order the
revisions, `response` is the person's answer to the current one, and
`reply_revision` counts the answers given, which is how Cookie-Worker names each
reply mail so that a retried request cannot send it twice.

It also adds `calendar_events.invitation_id`, with a unique index on
`(invitation_id, event_date)`: an invitation's entries exist once per day they
cover and no more. The foreign key clears the link rather than deleting the
entry if an invitation row is ever removed.

Apply it before deploying Cookie-Worker's `cookie-web-messages` and
`cookie-web-send`. Until then the messages Worker reports no invitation and the
reader keeps its "Add to calendar" offer. No API role can read either table's
new data; Cookie-Worker uses its own database role.

## Cc and Bcc recipients (0114)

`0114_cc_bcc_recipients.sql` adds `cc_addresses` and `bcc_addresses` to `drafts`
and `scheduled_sends`: the Cc and Bcc lines of a message that has not gone out
yet, each a comma-separated list like `to_addresses`, with `''` for a line that
is not used. A sent message already keeps all three lines in
`messages.recipients`.

Deploy Cookie-Worker's `cookie-web-send` and `cookie-web-drafts` before the
frontend that offers the two lines, so no message is sent by a Worker that
ignores them. Those Workers run with or without this migration: until it is
applied, a draft or a Send Later that has a Cc or Bcc line fails to save and
says so, and everything else is unaffected.

## Task reorders left out of task history (0117)

`0117_task_activity_ignore_position.sql` replaces `record_task_activity`
(0097, last replaced by 0098) so that `position` and `today_position` are no
longer part of the edit diff. A drag in a list, or a Todoist sync that shifts a
project's order, rewrites the position of every later task, and each of those
rows used to log an `edited` event. Every other tracked key is diffed as
before. Earlier "Reordered" events stay in `task_activity`.

It changes only the trigger function, so it can be applied at any time; no
Worker or frontend deploy depends on it.

## Mail list previews (0118)

`0118_message_ai_preview.sql` adds the nullable `message_ai.preview` column:
the sentence or two that `mail-app-ingest`'s classifier writes for the mail
list. Apply it before deploying `cookie-web-emails` and `mail-app-ingest` from
the same change, since both name the column; merging to `main` runs it before
either Worker is deployed. Existing rows keep `NULL` and the list shows their
snippet.
