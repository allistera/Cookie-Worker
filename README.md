# Cookie Workers

This repository hosts Cookie's independently deployable Cloudflare Workers. Each Worker owns its source, tests, generated environment types, local secret template, and Wrangler configuration under `workers/<name>/`. Root tooling discovers those directories, so adding a Worker does not require another package, registry, or CI workflow.

## Workers

| Worker                                                         | Triggers                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`cookie-web-ai`](workers/cookie-web-ai)                       | HTTP (browser)                | AI writing for Cookie-Web's SPA — `POST /compose` (reviewable email drafts and reusable snippets; never sends mail), `POST /summarize` (owner-scoped one-line summaries persisted on `threads` with newest-message freshness) and `POST /document` (a title plus Editor.js blocks for the Documents app's "AI document" option; the SPA saves them through `cookie-web-tasks`). All share one Postgres-backed 'ai' rate-limit scope. Replaces Cookie-Web's `api/compose.js` + `api/summarize.js`.                                                                                                                                                                                                                                                                                                                                          |
| [`cookie-web-calendar`](workers/cookie-web-calendar)           | HTTP (browser)                | The Calendar app's API — `GET/POST/PATCH/DELETE /calendar-events` (with recurring-series expansion, range windowing, and an `action=interpret` natural-language AI path) and `/calendars` (CRUD, default seeding, and ICS subscription sync via `action=sync`). Replaces Cookie-Web's `api/calendar-events.js` + `api/_lib/calendars.js`/`calendarSync.js`/`calendar-ai.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [`cookie-web-drafts`](workers/cookie-web-drafts)               | HTTP (browser)                | Server-side composer drafts — `GET /drafts`, `GET/PATCH/DELETE /drafts/:id`, `POST /drafts`. Backs the SPA's Drafts view and the composer's autosave, which replaces the whole draft on every save rather than merging fields. Drafts are their own table (migration 0061), not `messages` rows: a draft is empty when created, has no sender, recipients, thread or sent time, and is rewritten every few seconds while someone types.                                                                                                                                                                                                                                                                                                                                                                                                    |
| [`cookie-web-emails`](workers/cookie-web-emails)               | HTTP (browser)                | The mailbox list itself — `GET /emails` (keyset-paginated folder listing: inbox, sent, spam, snoozed, done, starred, label), `GET /emails/state` (unread badge, Spam/Snoozed folder counts + Realtime channel identity bootstrap, previously `?resource=state`) and `GET/PUT /emails/spam-retention` (how many days spam is kept, 1–365, default 30, stored in `users.prefs`). Replaces Cookie-Web's `api/emails.js`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [`cookie-web-labels`](workers/cookie-web-labels)               | HTTP (browser)                | Label and label-rule CRUD for Cookie-Web's SPA — `GET/POST/PATCH/DELETE /labels` and `/labels/rules`. Previously multiplexed behind `api/labels.js?resource=rules` in Cookie-Web's own Vercel deployment purely to stay under Vercel Hobby's 12-function cap; here each is its own clean route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [`cookie-web-messages`](workers/cookie-web-messages)           | HTTP (browser)                | Message read/label/flag/spam-report/unsubscribe and attachment download for Cookie-Web's SPA — `GET/POST/PATCH /messages` (`PATCH` accepts `is_spam`, the user's own verdict, written to `message_ai.spam_verdict` with `provider = 'user'` so enrichment never overturns it), plus `/messages/attachment`, `/messages/contacts`. Previously multiplexed behind `api/messages.js?resource=...` for the same Vercel Hobby function-cap reason as `cookie-web-labels`.                                                                                                                                                                                                                                                                                                                                                                       |
| [`cookie-web-send`](workers/cookie-web-send)                   | HTTP (browser, flusher cron)  | Outbound mail — `POST /send` (immediate Resend delivery with per-minute quota, idempotency keys, stored sent copy, read-receipt pixel, and best-effort Meilisearch indexing, or a queued scheduled send given `sendAt`), `GET/DELETE /send/scheduled`, and `POST /send/flush` (bearer-token protected; driven by scheduled-send-flusher over a service binding). Replaces Cookie-Web's `api/send.js`, its last Vercel function.                                                                                                                                                                                                                                                                                                                                                                                                            |
| [`cookie-web-search`](workers/cookie-web-search)               | HTTP (browser)                | Hybrid mail search and the RAG assistant — `GET /search` (Meilisearch hybrid search over the `messages` index; `mode=keyword` pins `semanticRatio` to 0 for the quota-free type-ahead path) and `POST /ask` (retrieve-then-answer over the owner's mail with sources). Shares the 'ai' rate-limit scope. Replaces Cookie-Web's `api/search.js` + `api/ask.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [`cookie-web-tasks`](workers/cookie-web-tasks)                 | HTTP (browser)                | AI Today's task list, digest, and news (`GET/POST /tasks`), on-demand triage refresh (`/tasks/refresh`), owner-only model/schedule preferences (`/tasks/enrichment-settings`), news personalization and daily-note defaults (`/tasks/interests`, `/tasks/daily-note-seed`), document image uploads (`/tasks/image-upload`), and the full Documents feature — folders, documents, templates, and Meilisearch hybrid search over the `documents` index (`GET/POST/PATCH/DELETE /documents`). Previously multiplexed behind `api/tasks.js?resource=...` for the same Vercel Hobby function-cap reason as `cookie-web-labels`; this is the largest of the three multiplexing-removal Workers. Its image upload was also redesigned to use the Web-standard `Request.formData()` instead of Cookie-Web's original hand-rolled multipart parser. |
| [`cookie-web-notifications`](workers/cookie-web-notifications) | HTTP (browser)                | Browser-notification event claim/ack for Cookie-Web's SPA — `POST /notification-event`. A 30-second lease (`claim`) guarantees exactly one tab shows a new-mail notification, and `ack` deletes the event once shown. Replaces Cookie-Web's `api/notification-event.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [`cookie-web-receipts`](workers/cookie-web-receipts)           | HTTP (browser, email clients) | Read receipts — `GET /read-receipts`. Serves the unauthenticated 1×1 tracking pixel embedded in sent mail (`?token=`, per-IP flood-guarded, response identical for any token so mailbox state never leaks) and the SPA's authenticated receipt-status read (`?messageIds=`). Replaces Cookie-Web's `api/read-receipts.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [`mail-app-ingest`](workers/mail-app-ingest)                   | Email, scheduled              | Parse and store inbound mail, forward the original, and enrich the stored copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [`data-enricher`](workers/data-enricher)                       | Scheduled (hourly), manual    | Stores AI task analyses of important emails, three-tier inbox triage, and a personalised news round-up (GitHub, Product Hunt, BBC UK, and Edinburgh Live's West Lothian feed). The hourly trigger runs only in the owner-configured Europe/London slots (default every day, 09:00–19:00 inclusive) and defaults to `gpt-5-nano`. Feeds Cookie-Web's AI Today page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [`scheduled-send-flusher`](workers/scheduled-send-flusher)     | Scheduled (every 5 minutes)   | Calls Cookie-Web's `POST /api/send?resource=flush` so "Send Later" mail actually goes out once due; owns no mail-sending logic itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`cookie-web-ai` also provides authenticated `POST /rule-draft` with
`{ "instruction": "Tag receipts as Finance" }` (1–1000 characters). It returns an
unsaved `{ draft, model }` using the existing compose model and shared AI quota.
Only the owner's user-label IDs/names are supplied to the model. Generated fields,
matcher limits and label ownership are checked before returning the draft; an
unknown tag remains unselected for user review. Unsupported requests return 422;
invalid model output or upstream failures return 502. No rule or email writes
occur here: the frontend saves the reviewed draft through `POST /labels/rules`
only when **Create Rule** is clicked. Deploy `cookie-web-ai` before the updated
frontend; no migration or new secret is needed.

The `data-enricher` triage policy adapts Eric Porres's MIT-licensed [Email Triage Skill](https://github.com/ericporres/email-triage-plugin): **Reply Needed** and **Review** messages are shown individually, while **Noise** is summarized by category and omitted from AI Inbox rows. Cookie applies the policy to its own Postgres mailbox through the OpenAI Responses API; it does not embed the Claude plugin or depend on Gmail MCP at runtime.

## Repository structure

```text
workers/
  mail-app-ingest/
    src/
    test/
    wrangler.jsonc
    jsconfig.json
    worker-configuration.d.ts
    .dev.vars.example
scripts/
  workers.mjs
test/
  repository/
```

A directory is a Worker capsule when it contains `workers/<name>/wrangler.jsonc`. All capsules share the root dependency graph and lint, typecheck, and test configuration. Put code in a shared root module only after at least two Workers actually use it.

## Worker commands

Every command requires an explicit Worker name or `--all`; production deploys never accept `--all`.

```sh
npm run workers
npm run dev -- mail-app-ingest
npm run dev:all
npm run types -- --all
npm run dry-run -- --all
npm run deploy -- mail-app-ingest
```

`dev:all` passes every discovered configuration to one Wrangler development session, which supports service bindings between Workers. `dry-run --all` and `types --all` run once per Worker and stop on the first failure.

To add a Worker, create `workers/<name>/src/index.js`, `wrangler.jsonc`, `jsconfig.json`, tests, `.dev.vars.example`, and generated `worker-configuration.d.ts`. The directory name and Wrangler `name` must match and use lowercase letters, numbers, and dashes. CI discovers, typechecks, and dry-runs the new config automatically; the manual Deploy workflow accepts the same directory name as its `worker` input.

Python capsules (`main` ending in `.py`, with the `python_workers` compatibility flag) skip `jsconfig.json` and the per-Worker TypeScript check but go through the same discovery, types, and dry-run gates. None exist today — `data-enricher` was prototyped in Python and rewritten in JavaScript because vendored PyPI packages (via pywrangler) pushed the bundle past the free-plan size cap and Python still lacks a Hyperdrive driver. If a Python Worker returns, its deploys must go through `uv run pywrangler deploy` so vendored packages ship with it.

## Error reporting

Every Worker reports uncaught failures to the same Sentry project through `Sentry.withSentry`, and the failures it catches on purpose through explicit captures. The shared policy lives in [`shared/sentry.js`](shared/sentry.js); each Worker adds a thin `src/sentry.js` naming itself and listing the secrets it holds.

- Events carry a `service` tag (the Worker name) and an `operation` tag on captured failures, so one project stays readable.
- Workers answering more than one trigger tag each invocation `scheduled` or `http`.
- Request bodies, headers, cookies, query parameters, user identity, AI inputs and outputs, and stack-frame variables are all switched off.
- Connection strings and API tokens are stripped from messages and stack traces before capture, and from the structured log lines beside them.
- Sampling is off (`tracesSampleRate: 0`); errors only.
- Without `SENTRY_DSN` the client stays disabled, so local development and dry runs report nothing.

Both variables are the same everywhere: `SENTRY_DSN` (secret, synchronized by the `Deploy` workflow) and `SENTRY_ENVIRONMENT` (variable, set in each `wrangler.jsonc`).

## Cookie Web API Workers

`cookie-web-ai`, `cookie-web-calendar`, `cookie-web-drafts`, `cookie-web-emails`, `cookie-web-labels`, `cookie-web-messages`, `cookie-web-search`, `cookie-web-send`, `cookie-web-tasks`, `cookie-web-notifications`, and `cookie-web-receipts` are different from the other three Workers here: they're called directly by Cookie-Web's browser SPA (a real `fetch()` from user-facing JavaScript), not server-to-server over a bearer token. Two things follow from that, shared by all eleven (with two deliberate exceptions: `cookie-web-receipts`'s pixel route skips auth, and `cookie-web-send`'s /send/flush authenticates with the flusher's bearer secret instead — see their bullets below):

- **CORS**: every response carries `Access-Control-Allow-Origin` for allowed origins only (Cookie-Web's own production origin, any `http://localhost:*` for local dev, and any `https://*.vercel.app` preview deployment), and `OPTIONS` preflight requests are answered before auth runs. This logic lives in [`shared/cors.js`](shared/cors.js).
- **Auth**: both verify the same Auth0-issued access token Cookie-Web's own Vercel API already does, via `jose`'s JWKS/JWT verification (pure Web Crypto, so it runs unchanged on Workers). See [`shared/auth-jwt.js`](shared/auth-jwt.js), ported from Cookie-Web's `api/_lib/auth.js`.

Each replaces a Vercel API file; the first three routed multiple resources through a `?resource=` query param purely to stay under the Hobby plan's 12-serverless-function cap. None of these Workers has that limit, so the routes are plain:

- `cookie-web-ai` replaces `api/compose.js` + `api/summarize.js` (separate files on Vercel only because of the function-per-file model — same auth, same OpenAI key, same shared 'ai' rate-limit scope): `POST /compose`, `POST /summarize` and `POST /document`.
- `cookie-web-calendar` replaces `api/calendar-events.js` + `api/_lib/calendars.js`/`calendarSync.js`/`calendar-ai.js`: `GET/POST/PATCH/DELETE /calendar-events` and `/calendars` (was `?resource=calendars`). Its subscription sync re-uses the shared DoH-based `shared/safe-https.js` boundary (moved there from cookie-web-messages) in place of Cookie-Web's IP-pinning `safe-https.js` — same documented trade-off as one-click unsubscribe.
- `cookie-web-emails` replaces `api/emails.js`: `GET /emails` and `/emails/state` (was `?resource=state`).
- `cookie-web-send` replaces `api/send.js` (Cookie-Web's last Vercel function): `POST /send`, `GET/DELETE /send/scheduled` (was `?resource=scheduled`), and `POST /send/flush` (was `?resource=flush`). The fire-and-forget sent-mail indexing became a `ctx.waitUntil` task on its own short-lived database connection, and the idempotency-key hash moved from node:crypto to Web Crypto.
- `cookie-web-search` replaces `api/search.js` + `api/ask.js` and their shared retrieval stack (`api/_lib/retrieval.js` and `rank-fusion.js`, both since deleted along with the pgvector path — Cookie-Web keeps `query-parse.js` for its vite fixture and `api/send.js`): `GET /search` and `POST /ask`.
- `cookie-web-drafts` is new rather than a port: nothing served drafts before, since the only outbound state that survived a reload was the undo-send holding row. `GET /drafts`, `POST /drafts`, `GET/PATCH/DELETE /drafts/:id`. Autosave writes are rate-limited per user (`drafts-autosave` scope); reads never are, so opening the Drafts view always works.
- `cookie-web-labels` replaces `api/labels.js` + `api/_lib/label-rules.js`: `GET/POST/PATCH/DELETE /labels` and `/labels/rules`.
- `cookie-web-messages` replaces `api/messages.js` + `api/_lib/contacts.js`: `GET/POST/PATCH /messages`, plus `/messages/attachment`, `/messages/contacts`.
- `cookie-web-tasks` replaces `api/tasks.js` and its full dependency chain (`api/_lib/enricher.js`, `interests.js`, `dailyNoteSeed.js`, `imageUpload.js`, and the ~700-line `documents.js` folders/documents/templates/search subsystem): `GET/POST /tasks`, CRUD and natural-language interpretation under `/task-items`, plus `/tasks/refresh`, `/tasks/enrichment-settings`, `/tasks/interests`, `/tasks/daily-note-seed`, `/tasks/image-upload`, and `GET/POST/PATCH/DELETE /documents`.
- `cookie-web-notifications` replaces `api/notification-event.js` (never multiplexed — it was a single endpoint on Vercel too): `POST /notification-event`, the claim/ack lease that guarantees exactly one tab shows a new-mail browser notification.
- `cookie-web-receipts` replaces `api/read-receipts.js` (also never multiplexed): `GET /read-receipts`. `?messageIds=` is the SPA's authenticated receipt-status read; `?token=` is the unauthenticated 1×1 tracking pixel embedded in sent mail — recipients' email clients hold no bearer token, so auth deliberately does not run on that path, and the response is byte-identical for valid, invalid, expired, or rate-limited tokens so mailbox state never leaks. Its per-IP flood guard ports over per-isolate (was per-serverless-instance) and keys on `CF-Connecting-IP` instead of parsing `X-Forwarded-For`. Old sent mail still points its pixel at Cookie-Web's Vercel origin; a `vercel.json` redirect forwards those opens here.

`cookie-web-messages`'s one-click-unsubscribe POST (a server-side request to a URL taken from an untrusted email header) needed a genuine redesign, not a mechanical port. Cookie-Web's original `api/_lib/safe-https.js` resolves the hostname itself and pins the actual HTTPS connection to that exact verified IP (Node's `https.request({ lookup })`) — closing a DNS-rebinding attack where a malicious domain answers with a safe IP for the check and a private one moments later for the real connection. Workers' `fetch()` has no equivalent pinning primitive, so [`workers/cookie-web-messages/src/safeHttps.js`](workers/cookie-web-messages/src/safeHttps.js) instead pre-resolves via Cloudflare's DNS-over-HTTPS resolver and rejects if any A/AAAA record is private — blocking the common case (a domain that just points at an internal address) without closing the narrower, timing-dependent DNS-rebinding gap. Documented as an explicit trade-off in that file.

`cookie-web-tasks`'s image upload (`POST /tasks/image-upload`) also changed, though not for a security reason: Cookie-Web's original `api/_lib/imageUpload.js` hand-rolled a binary-string multipart/form-data parser because Vercel's Node runtime handed it a raw request stream. Workers' Web-standard `Request` gives `formData()` natively, so [`workers/cookie-web-tasks/src/imageUpload.js`](workers/cookie-web-tasks/src/imageUpload.js) uses that instead and drops the hand-rolled parser entirely.

Each is on its own custom domain (`ai-api` / `calendar-api` / `emails-api` / `send-api` / `labels-api` / `messages-api` / `search-api` / `tasks-api` / `notifications-api` / `receipts-api` `.infinitywave.online`, see each `wrangler.jsonc`), matching Cookie-Web's `src/lib/apiWorkers.js`. The `workers.dev` URLs stay enabled alongside for debugging.

## Mail app ingest

`mail-app-ingest` is Cookie's Cloudflare Email Worker. It parses inbound mail, stores it in Supabase through Hyperdrive, forwards the original, and enriches the stored copy with OpenAI.

Forwarding is the primary outcome. Storage, AI, search-indexing, and monitoring failures do not intentionally prevent delivery.

## Request flow

```text
Cloudflare Email Routing
  -> parse MIME
  -> store idempotently through Hyperdrive (+ apply matching conditions rules)
  -> forward original email
  -> close ingest database client
  -> waitUntil(AI classification on a fresh client)
```

Transient forwarding errors are re-thrown so the sending server can retry. Permanent forwarding errors are accepted only when the message was stored safely.

## Capabilities

- Parses MIME bodies and uploads attachment bytes to private Vercel Blob storage.
- Rejects parsing above 10 MiB while still forwarding the original.
- Stores messages idempotently by user and RFC Message-ID.
- Creates durable pending AI state inside the storage transaction.
- Applies user-defined conditions rules (subject/body/from/to matching) synchronously inside the storage transaction, before AI enrichment runs. Prompt-defined AI rules (`label_rules.kind = 'ai'`) are judged by the enrichment classifier in the same call that auto-tags by label description, and apply their label or mark the message done above the shared 0.7 confidence bar.
- Auto-tags enabled user labels from a strict structured response.
- Automatically saves an editable reply draft after an inbound email is classified as high priority and inbox-safe. It uses the existing `OPENAI_API_KEY`; the draft is never sent by ingestion. Existing drafts, newer thread messages, scheduled replies, deleted/archived mail, and no-reply senders are skipped.
- Classification attempts (including provider retries) and automatic reply generation share a Postgres-backed budget of 200 model requests per mailbox owner per 24-hour fixed window. Exhaustion defers AI work without rejecting mail or consuming a reply-generation attempt; recovery uses the same budget. Provider or database failures never grant extra budget.
- Recovers priority reply drafts on the 15-minute cron, three messages per tick and at most three attempts per message. Unanswered priority mail from the last 30 days is included. Completed/skipped state survives sending or discarding the draft, so retries cannot recreate it.
- Moves only spam scored at least `0.98` into the Spam folder. A verdict the user recorded from the reader (`message_ai.provider = 'user'`) is never overwritten.
- Indexes the message into Meilisearch, which generates its own vector.
- Retries stale pending or failed AI work every 15 minutes in batches of three.
- Soft-deletes spam that has been in the Spam folder longer than its owner's retention (`users.prefs.spamRetentionDays`, default 30 days; set from Cookie-Web's Settings → Spam) on the same 15-minute cron, at most 500 rows per tick, and marks them for the search drift sweep.
- Reports sanitised failures to Sentry without email or model content.

The shared schema and migrations live in the [Cookie-Web repository](https://github.com/allistera/Cookie-Web/tree/main/migrations).

Automatic priority replies require Cookie-Web migration `0069_priority_reply_drafts.sql`
before deploying `mail-app-ingest` and `cookie-web-drafts`. The latter exposes
`isAiGenerated` on saved drafts so the web reader can display them inline.
Draft generation has its own status and retry lease in `message_ai`, independent
of classification. A failed draft does not reclassify the email or affect delivery.

## Requirements

- Node.js 22 or newer.
- npm.
- Cloudflare Workers, Email Routing, and Hyperdrive.
- A compatible Supabase Postgres database with Cookie-Web migrations applied.
- A separate development database for local testing.

## Local setup

Install dependencies and copy the secret template:

```sh
npm install
cp workers/mail-app-ingest/.dev.vars.example workers/mail-app-ingest/.dev.vars
```

Point local Hyperdrive at a development Supabase session pooler:

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgres://postgres.PROJECT_REF:password@aws-0-REGION.pooler.supabase.com:5432/postgres'
```

Never use the production database for local development.

Start Wrangler:

```sh
npm run dev -- mail-app-ingest
```

Post the included fixture to the local email handler:

```sh
curl --request POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=inbox@example.org' \
  --data-binary @workers/mail-app-ingest/test/fixtures/simple.eml
```

Wrangler logs local forwarding instead of delivering. Posting the fixture again should report a `duplicate` storage outcome.

## Configuration

| Name                    | Type     | Purpose                                                                                                                                                                                                                                                                                            |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYPERDRIVE`            | Binding  | Supabase connection configured in `workers/mail-app-ingest/wrangler.jsonc`.                                                                                                                                                                                                                        |
| `FORWARD_TO`            | Variable | Verified mailbox receiving the original email.                                                                                                                                                                                                                                                     |
| `OWNER_EMAIL`           | Variable | Exact Cookie-Web user email that owns stored messages.                                                                                                                                                                                                                                             |
| `AI_MODEL`              | Variable | Structured classification model; defaults to `gpt-5.6-luna`.                                                                                                                                                                                                                                       |
| `OPENAI_API_KEY`        | Secret   | AI classification and mailbox Q&A. A restricted key needs write access to `/v1/responses` only — no Worker calls `/v1/embeddings`. The GitHub Actions secret of the same name does need the `/v1/embeddings` scope, because the reindex script hands it to Meilisearch as its embedder credential. |
| `SENTRY_DSN`            | Secret   | Production error reporting.                                                                                                                                                                                                                                                                        |
| `BLOB_READ_WRITE_TOKEN` | Secret   | Upload access to Cookie-Web's private attachment Blob store.                                                                                                                                                                                                                                       |
| `SENTRY_ENVIRONMENT`    | Variable | Sentry environment name.                                                                                                                                                                                                                                                                           |

The database password belongs to Hyperdrive, not Worker secrets. GitHub Actions passes production secrets to Wrangler during deployment.

## Validation

```sh
npm run lint
npm run types -- --all --check
npm run typecheck
npm test
npm run dry-run -- --all
```

## Deployment

Production deployment is intentionally manual through the GitHub Actions `Deploy` workflow. Keep the default `all` target to validate the repository once and deploy every Worker sequentially, or enter one Worker directory name to publish only that Worker. Individual deployments dry-run the selected Worker again. `mail-app-ingest`, `data-enricher`, and `scheduled-send-flusher` each synchronize their own GitHub secrets during deployment (scoped per Worker in `deploy.yml`), so no Worker receives another Worker's credentials.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENAI_API_KEY`
- `SENTRY_DSN`
- `BLOB_READ_WRITE_TOKEN`
- `HTTP_TRIGGER_TOKEN` — shared manual-trigger secret for `data-enricher`'s and `scheduled-send-flusher`'s own `POST /run` HTTP endpoints. `data-enricher` also accepts `POST /run?phase=today` (rebuild both AI Today cards) and the legacy `?phase=digest` name (inbox triage alone); Cookie-Web's AI Today refresh calls the former through `POST /tasks/refresh`, so its `ENRICHER_TRIGGER_TOKEN` must match this value.
  `data-enricher`'s news round-up takes two further, optional secrets. These are **not** synced by the `Deploy` workflow — `wrangler-action` fails the entire deploy when a listed secret has no value, and these may legitimately be unset. Set them once; Cloudflare keeps them across later deploys.

Run these from the Worker's own directory. Each Worker holds its own `wrangler.jsonc` and the repository root has none, so from anywhere else wrangler fails with "Required Worker name missing":

```sh
cd workers/data-enricher
npx wrangler secret put PRODUCT_HUNT_TOKEN
npx wrangler secret put GITHUB_API_TOKEN
```

- `PRODUCT_HUNT_TOKEN` — without it the Product Hunt section is skipped and the rest of the round-up still runs. Same token the `allistera/daily-news` project uses.
- `GITHUB_API_TOKEN` — only raises the GitHub search rate limit; the search works unauthenticated, and one request a day is well inside it. Not named `GITHUB_TOKEN` because Actions reserves that prefix for its own token, so a repository secret cannot use that name.
- `COOKIE_WEB_FLUSH_TOKEN` — bearer secret `scheduled-send-flusher` sends to Cookie-Web; must match Cookie-Web's `SCHEDULED_SEND_FLUSH_TOKEN` env var.

After the first deployment, configure the domain's Cloudflare Email Routing catch-all rule to invoke `mail-app-ingest`.

See [RUNBOOK.md](RUNBOOK.md) for deployment checks, AI recovery, secret rotation, and rollback.

### Task recurrence

Apply Cookie-Web migration `0066_task_items_recurrence.sql` before deploying
`cookie-web-tasks`. POST/PATCH `/task-items` accepts a nullable `recurrence`
string: `every Monday`, `every 2nd Tuesday` (monthly), `every last Friday`,
`every N days`, or `every N weeks` (N = 1–365), plus `daily`/`weekly` aliases.
Responses include the normalized `recurrence` and date-only `dueDate`.
When setting recurrence, send `today: YYYY-MM-DD` if there is no due date.

Completing a recurring occurrence requires `completed: true`, the caller's local
`today`, and `expectedDueDate` matching the displayed occurrence. It advances the
same task to the next future date, preserves interval cadence, resets its Today
rank, and leaves it incomplete. A stale/concurrent update returns 409. Save date
or recurrence edits separately before completing. Clearing `dueDate` clears
recurrence; setting `recurrence: null` alone preserves the date. Subtask states
are preserved and no separate occurrence history is recorded.

### Natural-language task quick add

Apply Cookie-Web migration `0067_task_items_time_and_labels.sql` before
deploying `cookie-web-tasks`. `POST /task-items/interpret` accepts `{ text,
timeZone }` and returns a task draft. The Worker extracts `p1`–`p4`,
`#Project`, and `@label` deterministically, matches only an existing project
owned by the caller, and uses the OpenAI Responses API for title, date, local
time, description, and recurrence. Interpretation shares the Postgres-backed
`ai` quota and allows 10 requests per user per minute.

POST/PATCH `/task-items` accepts `dueTime` as 24-hour `HH:MM`, its IANA
`timeZone`, and up to 20 labels. The response returns the same fields. Clearing
the due date also clears its time and zone. `OPENAI_API_KEY` is synchronized to
this Worker by the deploy workflow; without it the interpretation endpoint
returns a message directing the client to Advanced entry.

## Configurable auto archive

Deploy `cookie-web-emails` and `mail-app-ingest` before Cookie-Web's Auto Archive
settings UI. No migration or new secret is required: `users.prefs.autoArchive`
stores independent `marketing`, `coldPitches` and `socialNoise` entries, each with
an `enabled` boolean and server-generated `since` timestamp. GET/PUT
`/emails/auto-archive` exposes the three booleans and preserves unrelated preferences.

Enabled categories are included as built-in rules in the existing classification
call. Only inbox verdicts with low priority and confidence at least 0.95 qualify.
Prompts exclude direct/personal messages, receipts, transactional mail and security
alerts. Messages created before the category's activation are ineligible, including
delayed AI retries; disabling and re-enabling starts a new activation window.
Settings are rechecked when filing, and read, starred, scheduled, sent or deleted
messages are protected. Matches move to Done and are marked read. Queued browser
alerts are removed, but an alert already delivered before asynchronous AI processing
cannot be recalled. No historical backfill is run.

## Review-fix rollout

Apply Cookie-Web migration `0070_scheduled_send_requests.sql` before deploying
`cookie-web-send`. The optional `requestId` on a scheduled send now returns the
original row for an identical retry and HTTP 409 for different content under the
same id. Keep the restored `0066`–`0069` migration files in fresh-database setup;
already-recorded migrations must be skipped.

Deploy the updated `cookie-web-drafts` Worker before Web. `GET /drafts?view=summary`
returns preview text and attachment counts for the list; `GET /drafts/:id` loads
the full body and attachments when opened. Plain `GET /drafts` preserves the full
response for existing clients.

### AI Task plans

`POST /task-items/generate` accepts `{ text, timeZone }` (up to 1000 characters).
It uses the existing authenticated AI quota and `OPENAI_API_KEY` to generate a
title, description, and zero to eight useful subtasks. The parent and children
are saved together in one transaction in Inbox; the response is
`{ item, subtasks }` with status 201. Search indexing follows the commit.
Generation failures do not save tasks. The existing `/task-items/interpret`
quick-add parser remains available for explicit scheduling and shortcuts.
