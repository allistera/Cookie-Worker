# Cookie Workers

This repository hosts Cookie's independently deployable Cloudflare Workers. Each Worker owns its source, tests, generated environment types, local secret template, and Wrangler configuration under `workers/<name>/`. Root tooling discovers those directories, so adding a Worker does not require another package, registry, or CI workflow.

## Workers

| Worker | Triggers | Purpose |
| --- | --- | --- |
| [`cookie-web-labels`](workers/cookie-web-labels) | HTTP (browser) | Label and label-rule CRUD for Cookie-Web's SPA — `GET/POST/PATCH/DELETE /labels` and `/labels/rules`. Previously multiplexed behind `api/labels.js?resource=rules` in Cookie-Web's own Vercel deployment purely to stay under Vercel Hobby's 12-function cap; here each is its own clean route. |
| [`cookie-web-messages`](workers/cookie-web-messages) | HTTP (browser) | Message read/label/flag/unsubscribe and attachment download for Cookie-Web's SPA — `GET/POST/PATCH /messages`, plus `/messages/attachment`, `/messages/thread-body`, `/messages/contacts`. Previously multiplexed behind `api/messages.js?resource=...` for the same Vercel Hobby function-cap reason as `cookie-web-labels`. |
| [`mail-app-ingest`](workers/mail-app-ingest) | Email, scheduled | Parse and store inbound mail, forward the original, and enrich the stored copy. |
| [`data-enricher`](workers/data-enricher) | Scheduled (05:00 UTC daily), manual | Stores Todoist tasks due today, AI task analyses of important emails, three-tier inbox triage, and a personalised news round-up (GitHub, Product Hunt, BBC UK). Feeds Cookie-Web's AI Today page. |
| [`scheduled-send-flusher`](workers/scheduled-send-flusher) | Scheduled (every 5 minutes) | Calls Cookie-Web's `POST /api/send?resource=flush` so "Send Later" mail actually goes out once due; owns no mail-sending logic itself. |

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

`cookie-web-labels` and `cookie-web-messages` are different from the other three Workers here: they're called directly by Cookie-Web's browser SPA (a real `fetch()` from user-facing JavaScript), not server-to-server over a bearer token. Two things follow from that, shared by both:

- **CORS**: every response carries `Access-Control-Allow-Origin` for allowed origins only (Cookie-Web's own production origin, any `http://localhost:*` for local dev, and any `https://*.vercel.app` preview deployment), and `OPTIONS` preflight requests are answered before auth runs. This logic lives in [`shared/cors.js`](shared/cors.js).
- **Auth**: both verify the same Auth0-issued access token Cookie-Web's own Vercel API already does, via `jose`'s JWKS/JWT verification (pure Web Crypto, so it runs unchanged on Workers). See [`shared/auth-jwt.js`](shared/auth-jwt.js), ported from Cookie-Web's `api/_lib/auth.js`.

Both replace a Vercel API file that routed multiple resources through a `?resource=` query param purely to stay under the Hobby plan's 12-serverless-function cap. Neither Worker has that limit, so the routes are plain:

- `cookie-web-labels` replaces `api/labels.js` + `api/_lib/label-rules.js`: `GET/POST/PATCH/DELETE /labels` and `/labels/rules`.
- `cookie-web-messages` replaces `api/messages.js` + `api/_lib/contacts.js`: `GET/POST/PATCH /messages`, plus `/messages/attachment`, `/messages/thread-body`, `/messages/contacts`.

`cookie-web-messages`'s one-click-unsubscribe POST (a server-side request to a URL taken from an untrusted email header) needed a genuine redesign, not a mechanical port. Cookie-Web's original `api/_lib/safe-https.js` resolves the hostname itself and pins the actual HTTPS connection to that exact verified IP (Node's `https.request({ lookup })`) — closing a DNS-rebinding attack where a malicious domain answers with a safe IP for the check and a private one moments later for the real connection. Workers' `fetch()` has no equivalent pinning primitive, so [`workers/cookie-web-messages/src/safeHttps.js`](workers/cookie-web-messages/src/safeHttps.js) instead pre-resolves via Cloudflare's DNS-over-HTTPS resolver and rejects if any A/AAAA record is private — blocking the common case (a domain that just points at an internal address) without closing the narrower, timing-dependent DNS-rebinding gap. Documented as an explicit trade-off in that file.

Neither is yet on a custom domain — both deploy to their `workers.dev` URL (`workers_dev: true`) until Cookie-Web's frontend fetch base URL and each Worker's `ALLOWED_ORIGIN` var are pointed at a real one.

## Mail app ingest

`mail-app-ingest` is Cookie's Cloudflare Email Worker. It parses inbound mail, stores it in Supabase through Hyperdrive, forwards the original, and enriches the stored copy with OpenAI.

Forwarding is the primary outcome. Storage, AI, embedding, and monitoring failures do not intentionally prevent delivery.

## Request flow

```text
Cloudflare Email Routing
  -> parse MIME
  -> store idempotently through Hyperdrive (+ apply matching tag rules)
  -> forward original email
  -> close ingest database client
  -> waitUntil(AI classification + embedding on a fresh client)
```

Transient forwarding errors are re-thrown so the sending server can retry. Permanent forwarding errors are accepted only when the message was stored safely.

## Capabilities

- Parses MIME bodies and uploads attachment bytes to private Vercel Blob storage.
- Rejects parsing above 10 MiB while still forwarding the original.
- Stores messages idempotently by user and RFC Message-ID.
- Creates durable pending AI state inside the storage transaction.
- Applies user-defined tag rules (subject/body/from/to conditions) synchronously inside the storage transaction, before AI enrichment runs.
- Auto-tags enabled user labels from a strict structured response.
- Moves only spam scored at least `0.98` into the Spam folder.
- Creates `text-embedding-3-small` vectors for semantic search.
- Retries stale pending or failed AI work every 15 minutes in batches of three.
- Reports sanitised failures to Sentry without email or model content.

The shared schema and migrations live in the [Cookie-Web repository](https://github.com/allistera/Cookie-Web/tree/main/migrations).

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

| Name | Type | Purpose |
| --- | --- | --- |
| `HYPERDRIVE` | Binding | Supabase connection configured in `workers/mail-app-ingest/wrangler.jsonc`. |
| `FORWARD_TO` | Variable | Verified mailbox receiving the original email. |
| `OWNER_EMAIL` | Variable | Exact Cookie-Web user email that owns stored messages. |
| `AI_MODEL` | Variable | Structured classification model; defaults to `gpt-5.6-luna`. |
| `OPENAI_API_KEY` | Secret | AI classification and embeddings. Restricted keys need write access to both `/v1/responses` and `/v1/embeddings`. |
| `SENTRY_DSN` | Secret | Production error reporting. |
| `BLOB_READ_WRITE_TOKEN` | Secret | Upload access to Cookie-Web's private attachment Blob store. |
| `SENTRY_ENVIRONMENT` | Variable | Sentry environment name. |

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
- `TODOIST_API_TOKEN`
- `HTTP_TRIGGER_TOKEN` — shared manual-trigger secret for `data-enricher`'s and `scheduled-send-flusher`'s own `POST /run` HTTP endpoints. `data-enricher` also accepts `POST /run?phase=today` (rebuild both AI Today cards) and the legacy `?phase=digest` name (inbox triage alone); Cookie-Web's AI Today refresh calls the former through `POST /api/tasks?resource=refresh`, so its `ENRICHER_TRIGGER_TOKEN` must match this value.
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
