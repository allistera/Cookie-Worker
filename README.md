# Cookie Workers

This repository hosts Cookie's independently deployable Cloudflare Workers. Each Worker owns its source, tests, generated environment types, local secret template, and Wrangler configuration under `workers/<name>/`. Root tooling discovers those directories, so adding a Worker does not require another package, registry, or CI workflow.

## Workers

| Worker | Triggers | Purpose |
| --- | --- | --- |
| [`mail-app-ingest`](workers/mail-app-ingest) | Email, scheduled | Parse and store inbound mail, forward the original, and enrich the stored copy. |
| [`data-enricher`](workers/data-enricher) | Scheduled (05:00 UTC daily) | Stores Todoist tasks due today and AI task analyses of important emails. |
| [`scheduled-send-flusher`](workers/scheduled-send-flusher) | Scheduled (every 5 minutes) | Calls Cookie-Web's `POST /api/send?resource=flush` so "Send Later" mail actually goes out once due; owns no mail-sending logic itself. |

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

Production deployment is intentionally manual through the GitHub Actions `Deploy` workflow. Select the Worker directory name when dispatching it. The workflow validates the entire repository, dry-runs the selected Worker again, and publishes only that Worker. `mail-app-ingest`, `data-enricher`, and `scheduled-send-flusher` each synchronize their own GitHub secrets during deployment (scoped per Worker in `deploy.yml`), so no Worker receives another Worker's credentials.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENAI_API_KEY`
- `SENTRY_DSN`
- `BLOB_READ_WRITE_TOKEN`
- `TODOIST_API_TOKEN`
- `HTTP_TRIGGER_TOKEN` — shared manual-trigger secret for `data-enricher`'s and `scheduled-send-flusher`'s own `POST /run` HTTP endpoints.
- `COOKIE_WEB_FLUSH_TOKEN` — bearer secret `scheduled-send-flusher` sends to Cookie-Web; must match Cookie-Web's `SCHEDULED_SEND_FLUSH_TOKEN` env var.

After the first deployment, configure the domain's Cloudflare Email Routing catch-all rule to invoke `mail-app-ingest`.

See [RUNBOOK.md](RUNBOOK.md) for deployment checks, AI recovery, secret rotation, and rollback.
