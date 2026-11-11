# Cookie Worker runbook

This runbook covers deployment, verification, recovery, and rollback for the email-ingest Worker.

## Preconditions

Apply the Cookie Web migrations before deploying Worker changes that depend on them. AI enrichment requires migrations `0010` and `0011`.

Confirm the Cloudflare Worker has its email route, Hyperdrive binding, required variables, and the `OPENAI_API_KEY`, `SENTRY_DSN`, and `BLOB_READ_WRITE_TOKEN` secrets.

`data-enricher` and `scheduled-send-flusher` report to the same Sentry project and take the same `SENTRY_DSN` secret; the `Deploy` workflow synchronizes it for all three. Errors are separated by their `service` tag, and by a `trigger` tag distinguishing cron runs from manual `POST /run` calls.

## Deploy

Run the `Deploy` workflow in GitHub Actions. Keep the default `all` target for a coordinated deployment of every Worker, or enter one Worker directory name for an individual deployment. The workflow validates every Worker first, then uploads only each selected Worker's secrets immediately before deploying its Wrangler configuration.

For local validation before deployment:

```bash
npm ci
npm run lint
npm run types -- --all --check
npm run typecheck
npm test
npm run dry-run -- --all
```

## Verify production

Send a message from an external account to the configured Cloudflare Email Routing address. Verify:

- The message arrives at `FORWARD_TO`.
- A row appears in `messages`, and Worker logs contain a `stored` event.
- Attachment rows carry private Blob URLs and download successfully in Cookie Web.
- An `ai_enriched` event is written after classification completes.
- `message_ai.status` becomes `completed`.
- Suggested tags appear in Cookie Web.
- Spam above the threshold appears in the hidden Spam folder, not the inbox.
- Spam and blocked mail older than the owner's retention (default 30 days, Settings → Spam) is soft-deleted by the ingest cron; a `spam_purged` event with the total (`deleted`) and how much of it was blocked mail (`blocked`) is logged on ticks that delete anything.
- A scheduled or manually triggered recovery emits `ai_recovery_complete`.

Check Sentry for errors tagged with the Worker environment and processing stage.

## Search relevance

Ordinary mail searches include archived (Done) mail and exclude deleted mail;
explicit `in:` operators retain their folder-specific filters. The messages
index uses `sent_at:desc` only after textual ranking rules, one typo from six
characters and two from twelve, with no typo tolerance on addresses or numbers.
Text queries apply a 0.5 ranking-score floor; filter-only queries do not.
These settings are defined in `shared/meili/messages.js`. For ranking-only
changes, PATCH only `rankingRules` and `typoTolerance` on the existing index,
wait for the settings task to succeed, and read the settings back. No document
upload or embedder change is required; preserve unrelated index settings.

## AI enrichment and recovery

`data-enricher` now runs inbox triage only. Its hourly cron is gated by the
owner's saved Europe/London schedule. Authenticated `POST /run` and the existing
`?phase=today` / `?phase=digest` aliases rebuild triage immediately. Check
`triage_built`, `scheduled_run_skipped`, and `phase_failed` when diagnosing runs.
No news fetching/ranking or per-email task extraction runs; existing stored
news and extracted tasks remain readable. News-source credentials are unused.

The separate `mail-app-ingest` classification and recovery flow is unchanged:

After forwarding succeeds, the Worker starts best-effort enrichment with a fresh database client. Enrichment is AI classification only; search indexing is a separate best-effort write to Meilisearch.

The scheduled handler runs every 15 minutes. It retries up to three `pending` or `failed` rows older than two minutes.

## Search indexing

A message's search document is kept current by marking and sweeping. Any handler that changes an indexed field — flags, labels, the spam verdict — sets `messages.search_indexed_at` back to NULL in the same statement or transaction, then fires a best-effort sync that waits for Meilisearch task success (up to 20 seconds). Matching row versions are stamped; superseded writes clear the watermark so an older index write cannot hide drift. Document and task saves schedule indexing after the response using a separate connection. A row whose sync never landed keeps its NULL and is repaired later.

The same 15-minute cron that recovers enrichment also sweeps up to 200 such rows. Its log events are `search_drift_swept` (with `selected`, `indexed` and `failed` counts — check `failed`, not just the presence of the line), `search_drift_sweep_failed`, and `search_drift_sweep_misconfigured`. A non-zero `failed` also raises a handled exception in Sentry under the `search_drift_sweep` operation.

Two workflows back this up: `search-drift-repair.yml` reindexes drifted rows from CI, and `search-reindex.yml` rebuilds an index from scratch. The workflow drains oldest-first while the in-Worker sweep takes newest-first, so recent mail becomes searchable quickly and a large backlog still drains from the tail.

### Search health

Each sweep also measures what it left behind, so an index cannot rot while every tick reports success. The message sweep's `search_drift_swept` line carries `backlog`, the number of messages still unstamped after the tick; the workspace sweep's `workspace_search_drift_swept` line carries `backlog` and `backlog_age_seconds` per target, the count and the age of the oldest unindexed change (for a task, the newer of its own edit and its latest sub-task edit). Past a threshold, the tick raises an error-level Sentry message under the `search_health` operation with a fixed fingerprint per condition, so repeats stay one issue:

| Condition                                 | Fingerprint                           | Raised when                                                                                                                                                                                                                                                            | Tunable                                                   |
| ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Message repair is falling behind          | `messages-backlog`                    | More unstamped messages remain after a tick than the sweep drains in an hour (five ticks of 200)                                                                                                                                                                       | `SEARCH_BACKLOG_MAX_ROWS` (default 1000)                  |
| Document or task repair is falling behind | `documents-stale`, `task_items-stale` | The oldest unindexed change is older than the threshold after a tick, so four oldest-first ticks have passed it over                                                                                                                                                   | `SEARCH_STALE_MAX_MINUTES` (default 60)                   |
| Meilisearch failed indexing tasks         | `meili-task-failures`                 | Meilisearch reports tasks with status `failed` enqueued in the last 15 minutes: a document it cannot index, or an embedder call OpenAI refused. Logged as `meili_tasks_failed` with the count and one sample's index, type, error code and task uid, never its details | None; a failing lookup is a `meili_tasks_check` exception |

The task check runs on the workspace tick, which has its own subrequest budget. Writers that do not wait for their task (mail ingest's first push) never learn of a failed task, and the sweeps only see the row stay unstamped, so this check is where an embedder outage first shows. When it fires, read the failed task's error in Meilisearch (`GET /tasks?statuses=failed`) with the reindex key and fix the source row or the index settings before replaying the repair.

The same measurements reach Honeycomb on the cron's trace as `cookie.search.<index>.backlog`, `cookie.search.<index>.backlog_age_seconds` and `cookie.search.failed_tasks`.

### Search requests in Honeycomb and Sentry

`cookie-web-search` (and the document search in `cookie-web-tasks`) describe each request on its trace span with `cookie.search.*` attributes: `scope` (`mail`, `all`, `documents`, `tasks`, `ask`), `federated`, `mode` (`hybrid` or `keyword`), `has_text`, `filters` (operator count), `legs` (the indexes queried), `hits`, `hydrated`, `estimated_total`, `verified` and `verified_batches`, and `outcome` (`ok`, `empty_query`, `skipped`, `invalid`, `meili_transient`, `meili_rejected`). Query text never reaches the trace. Hits that did not hydrate from Postgres are stale index entries; zero hits on a hybrid query is a relevance question, not an availability one. The response's `Server-Timing` header splits `meili` (retrieval) from `hydrate` (Postgres) alongside the existing `total`.

A Meilisearch failure returns 503 and is reported to Sentry on its first occurrence rather than only as a sampled log line: `meili_search_transient` for a gateway answer from the tunnel (502-504, 520-530, or the SDK's disguised parse error) and `meili_search_rejected` for a verdict from Meilisearch itself, such as a filter on an attribute the index does not declare filterable. The two stay separate issues because they need different fixes; the `extra` carries `scope` and `mode`. The structured log lines (`message_search_meili_failed`, `federated_search_meili_failed`, `document_search_meili_failed`) now carry `transient` as well.

### Where Meilisearch runs

Since 2026-10-28 the Meilisearch instance behind `meilisearch.infinitywave.online` runs on the Oracle Cloud Always Free VM in Amsterdam that also hosts the agent workspace, not on the home server. It is a Docker Compose stack in `/home/ubuntu/meilisearch` on that VM: a pinned `getmeili/meilisearch` container bound to localhost, plus a `cloudflared` sidecar that runs the locally managed tunnel `cookie-meilisearch` (configured in `cloudflared/config.yml` there, not in the Zero Trust dashboard). The master key is in that directory's `.env`; the Workers' runtime key (`cookie-workers`: search, document add and delete, task polling), the reindex key (`cookie-reindex`: index, settings, document and task management) and the chat key (`cookie-chat`, see Assistant chat below) are in `.keys`. All three files are owner-readable only.

Search returns 503 whenever this instance is unreachable, and the vectors exist only in Meilisearch, so a new or restored instance needs `search-reindex.yml` with target `all`. Oracle reclaims idle Always Free instances; if the VM disappears, search goes with it. To move the index elsewhere, point the CNAME `meilisearch.infinitywave.online` at the new tunnel, rotate `MEILISEARCH_API_KEY` on the five Workers that use it (`cookie-web-search`, `cookie-web-send`, `cookie-web-messages`, `cookie-web-tasks`, `mail-app-ingest`) and in GitHub, rotate `MEILISEARCH_REINDEX_KEY` and `MEILISEARCH_CHAT_API_KEY` in GitHub (the chat key's uid is pinned in `cookie-web-search`'s vars, so create the new key with the same uid or change both), re-enable `chatCompletions`, then reindex.

### Assistant chat

The assistant drawer in Cookie-Web talks to `POST /chat` on `cookie-web-search`, which hands the conversation to Meilisearch's conversational search (`/chats/cookie/chat/completions`, experimental feature `chatCompletions`, enabled on 2026-11-07). Meilisearch gives the model one search tool over `messages`, `documents` and `task_items`, runs the searches itself with each index's `chat` settings (`shared/meili/*.js`: a description for the model, the Liquid template a hit is rendered with, hybrid search with five hits per search), and calls OpenAI through the same AI Gateway as the Workers.

Three things make it work and are where to look when it answers 503:

- **The chat key.** `cookie-chat` (uid `4f1c6b5e-0003-4000-8000-000000000003`, actions `search`, `chatCompletions`, `chatsSettings.update`, all indexes because `chatsSettings.update` is a global action) is the `MEILISEARCH_CHAT_API_KEY` secret of `cookie-web-search` and sits in `.keys` on the VM beside the other two. The Worker never sends it to Meilisearch for a chat: it signs a five-minute tenant token per request whose search rules pin every index to `user_id = <owner>` (and mail to `is_deleted = false`), and Meilisearch applies those rules to every search the model makes. A tenant token names its parent key by uid, which is the `MEILISEARCH_CHAT_API_KEY_UID` var.
- **The workspace.** `PATCH /chats/cookie/settings` (provider, OpenAI key, gateway URL, system prompt) is pushed by the Worker itself once per isolate from `workspaceSettings` in `src/chat.js` (the prompts themselves are in `src/chatPrompts.js`, with the model failures each line answers), so the prompt lives in the repo and the OpenAI key is the one secret every Worker already holds. A `chat_not_found` or `feature_not_enabled` answer makes the Worker push again on the next request; if the feature flag was lost (a rebuilt instance), re-enable it with the master key: `PATCH /experimental-features {"chatCompletions": true}`.
- **The index chat settings.** `configureIndex` sends them with the rest of an index's settings, so a reindex restores them; to change only them, PATCH `/indexes/<index>/settings/chat` with the descriptor's `chat` object and wait for the task, as with ranking changes above. The templates read `sent_date` (mail) and `updated_date` (documents, tasks), display-only twins of the epoch fields added on 2026-11-07 because Liquid cannot format an integer as a date; rows indexed before that show an empty time until the next reindex.

Structured logs: `chat_upstream_rejected` (status and Meilisearch error code) and `chat_upstream_error` (an error event inside the stream, usually the provider). Sentry: `meili_chat_failed` (could not reach Meilisearch or push the workspace) and `meili_chat_rejected` (Meilisearch answered with an error, `extra.code`). Each chat spends one unit of the shared `ai` quota (10 per minute per user), like `/ask`.

Cookie-Web's `api/send.js` now proxies to `cookie-web-send`, which owns sending and starts background indexing on its own connection. Deploy the updated send Worker before the Web adapter; scheduled and immediate sends share follow-up reminder handling.

AI failures do not block forwarding or storage. Inspect the OpenAI response, rate limits, secret configuration, database connectivity, and migration state.

## Email routing

Cloudflare Email Routing must target this Worker for the intended recipient address, or send everything to it through the catch-all rule. The Worker does not check the envelope recipient. It stores each message for the user whose `users.email` equals `OWNER_EMAIL`; if no user matches, storage fails, the message is not forwarded, and the sending MTA retries it.

If messages are not stored, confirm the exact recipient address, Hyperdrive project, and current database schema. Messages over the 10 MiB parse cap, or with too many MIME boundary lines, are forwarded without being stored; every other message is forwarded only after its storage commits.

After a message is stored (or its existing copy is confirmed), an explicit
Cloudflare `permanent error (5xx)` forwarding refusal is logged as
`forward_failed_permanent` and reported to Sentry, but the inbound delivery is
accepted. Replaying the same message cannot repair a permanent Gmail rejection.
The copy remains available in Cookie; this does not mean Gmail received it.
Transient SMTP failures and unknown failures still propagate for MTA retry. If
no stored copy exists, even a permanent forwarding refusal propagates so the
Worker does not silently accept mail it has neither stored nor forwarded.

## Inbound health

Two Sentry cron monitors watch the scheduled work: `mail-app-ingest-sweeps` (every 15 minutes) and `mail-app-ingest-workspace-search-drift` (at 7, 22, 37 and 52 past the hour). Sentry creates each monitor on its first check-in. A cron that stops running shows as a missed check-in.

After the sweeps, the 15-minute run also checks inbound health. Each failing condition is reported as an error-level Sentry message with a fixed fingerprint, so repeats on later ticks stay one issue:

- `Inbound mail has gone quiet` (`inbound-stale`): the newest stored inbound message is older than `INBOUND_STALE_HOURS` (default 12). That default sits above the 120-day p99 gap of 6.4 hours. Gaps of 16.7, 17.9 and 20.4 hours have each occurred, so a natural quiet spell that long will alert. Check the catch-all rule first.
- `Message enrichment has stayed pending` (`pending-enrichment`): a message's classification has been pending for longer than `PENDING_ENRICHMENT_MAX_MINUTES` (default 60). Check `OPENAI_API_KEY`, the shared AI budget, and recent `ai_recovery` reports.
- `Catch-all email routing no longer delivers to mail-app-ingest` (`email-routing-drift`): the catch-all rule is disabled or has no worker action naming this Worker. The check needs both `CLOUDFLARE_EMAIL_ROUTING_TOKEN` (a secret) and `EMAIL_ROUTING_ZONE_ID` (a variable). Without them it is skipped, and one log line says so. The token needs zone-scoped read access to Email Routing rules; confirm the exact permission name in Cloudflare's token form.

The routing API read retries a request timeout once after one second, with a fresh 10-second deadline. API rejections fail immediately and are reported as a failed check. A second timeout is only logged, as `email_routing_check_timed_out`: the next tick reads the rule again, and mail that has really stopped arriving is caught by the stale-inbound check.

A check that cannot run is reported as an `inbound_health` exception. The checks never throw, and a failing check does not stop the sweeps. The owner's address is never sent to Sentry.

## Database health

After the inbound checks, the 15-minute run reads Postgres's own statistics, which cover every client of the database and not only the Workers. Each failing condition is an error-level Sentry message under the `db_health` operation with a fixed fingerprint, so repeats on later ticks stay one issue. Every tick also logs one `db_health_checked` line with what it saw.

- `Database statements are running slower than their baseline` (`query-regression`): a statement's mean execution time since the previous tick is at least three times its mean before it, and at least `DB_REGRESSION_MIN_MS` (default 200). It needs five calls in the interval and twenty before it. The issue carries query ids, call counts and timings, never the statement. Read the statement in Supabase's SQL editor:

  ```sql
  SELECT query, calls, mean_exec_time, max_exec_time, rows
  FROM extensions.pg_stat_statements
  WHERE queryid = <worst_queryid>;
  ```

  Then run it under `EXPLAIN (ANALYZE, BUFFERS)` with representative values, and look in the Postgres logs: a statement that takes a second or longer is logged with its plan. Supabase's Query Performance report shows the same statistics with index advice.

- `Database queries have been running for a long time` (`long-running-query`): one of this role's queries has been active for longer than `DB_LONG_QUERY_SECONDS` (default 30) without waiting on a lock. Find it with `SELECT pid, now() - query_start AS running, state, wait_event_type, left(query, 120) FROM pg_stat_activity WHERE state = 'active' ORDER BY query_start;` and end it with `SELECT pg_cancel_backend(<pid>);` if it should not be running. The server's `statement_timeout` is two minutes.
- `Database sessions are waiting on locks` (`lock-wait`): a session has waited on a lock for more than ten seconds. `SELECT pid, pg_blocking_pids(pid) AS blocked_by, left(query, 120) FROM pg_stat_activity WHERE wait_event_type = 'Lock';` names the blocker; a migration holding a table lock and a transaction left open are the usual causes. Postgres also logs each lock wait.
- `Database connections are close to the limit` (`connection-saturation`): client sessions use at least 80% of `max_connections` (60 on the current instance; 19 were in use on 2026-11-11). Hyperdrive pools the Workers' connections, so look for a client that bypasses it: `SELECT usename, application_name, count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1, 2 ORDER BY 3 DESC;`.

The comparison needs the `db_query_stats` table from Cookie-Web migration `0112_db_query_stats.sql`, which holds the previous tick's counters. Until it is applied the comparison is skipped with one `db_query_stats_unavailable` log line per isolate and nothing is reported; the session checks run regardless. After a statistics reset, or when Postgres evicts a statement from `pg_stat_statements`, that statement is not compared on the next tick and gets a fresh baseline. The check sees a condition that lasts across a tick; for a single slow query between ticks use the query timings in Analytics Engine (README, "Query timings").

A check that cannot run is reported as a `db_health` exception with the check's name. The checks never throw, and a failing check does not change the cron's outcome.

## Local development

Copy the Worker's secret template beside its Wrangler configuration, set the documented environment values, and run:

```bash
cp workers/mail-app-ingest/.dev.vars.example workers/mail-app-ingest/.dev.vars
npm install
npm run dev -- mail-app-ingest
```

Use a development Supabase project. Do not connect local Worker sessions to production unless the task explicitly requires it.

## Rotate credentials

Update GitHub environment secrets first, then rerun the `Deploy` workflow. Confirm the deployed Worker reports no authentication errors.

`cookie-web-calendar`'s Google secrets are not in GitHub: rotate `GOOGLE_CLIENT_SECRET` with `wrangler secret put` after creating the new secret in the Google Cloud console. Rotating `GOOGLE_TOKEN_ENCRYPTION_KEY` makes every stored Google connection undecryptable — users see Google Calendar as needing a reconnect in Settings and sign in again; truncate `google_calendar_connections` first if the old ciphertext should not linger.

`cookie-web-tasks`'s `TODOIST_TOKEN_ENCRYPTION_KEY` is likewise not in GitHub. Rotating it makes every stored Todoist token undecryptable — the next sync records "The saved token could not be read" on each connection and Settings asks for the token again; truncate `todoist_connections` first if the old ciphertext should not linger. Mirrored tasks and projects keep their `todoist_id` and are picked up in place once a token is saved again.

When rotating the database password, update the Cloudflare Hyperdrive origin and the local connection string separately.

## Incident response

For AI-only failures, leave email routing active while investigating. Disable the scheduled trigger or roll back the Worker if retries are causing load or repeated errors.

For storage or delivery failures, inspect Worker logs and Sentry first. If needed, route mail directly to the fallback mailbox while the Worker is repaired.

## Rollback

Use the Cloudflare dashboard or `npx wrangler rollback --config workers/mail-app-ingest/wrangler.jsonc` to restore the last known-good Worker version.

Avoid rolling back database migrations during an incident. The AI schema changes are additive and safe to leave in place while the Worker is reverted.

## Task subtree repair

Coordinate `Cookie-Web/migrations/0065_task_subtree_projects.sql` with the updated tasks Worker. The migration repairs existing descendants into their root's project and adds an index on `parent_id`. The Worker serializes structural changes per owner and moves descendants in the same transaction as the parent. Older handlers can recreate the mismatch, so deploy the Worker promptly with the repair. No production migration is implied by a local test or deployment dry run.
