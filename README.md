# Cookie Worker

Cookie Worker (`mail-app-ingest`) is Cookie's Cloudflare Email Worker. It parses inbound mail, stores it in Supabase through Hyperdrive, forwards the original, and enriches the stored copy with OpenAI.

Forwarding is the primary outcome. Storage, AI, embedding, and monitoring failures do not intentionally prevent delivery.

## Request flow

```text
Cloudflare Email Routing
  -> parse MIME
  -> store idempotently through Hyperdrive
  -> forward original email
  -> close ingest database client
  -> waitUntil(AI classification + embedding on a fresh client)
```

Transient forwarding errors are re-thrown so the sending server can retry. Permanent forwarding errors are accepted only when the message was stored safely.

## Capabilities

- Parses MIME bodies and attachment metadata with `postal-mime`.
- Rejects parsing above 10 MiB while still forwarding the original.
- Stores messages idempotently by user and RFC Message-ID.
- Creates durable pending AI state inside the storage transaction.
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
cp .dev.vars.example .dev.vars
```

Point local Hyperdrive at a development Supabase session pooler:

```sh
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgres://postgres.PROJECT_REF:password@aws-0-REGION.pooler.supabase.com:5432/postgres'
```

Never use the production database for local development.

Start Wrangler:

```sh
npm run dev
```

Post the included fixture to the local email handler:

```sh
curl --request POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=inbox@example.org' \
  --data-binary @test/fixtures/simple.eml
```

Wrangler logs local forwarding instead of delivering. Posting the fixture again should report a `duplicate` storage outcome.

## Configuration

| Name | Type | Purpose |
| --- | --- | --- |
| `HYPERDRIVE` | Binding | Supabase connection configured in `wrangler.jsonc`. |
| `FORWARD_TO` | Variable | Verified mailbox receiving the original email. |
| `OWNER_EMAIL` | Variable | Exact Cookie-Web user email that owns stored messages. |
| `AI_MODEL` | Variable | Structured classification model; defaults to `gpt-5.6-luna`. |
| `OPENAI_API_KEY` | Secret | AI classification and embeddings. |
| `SENTRY_DSN` | Secret | Production error reporting. |
| `SENTRY_ENVIRONMENT` | Variable | Sentry environment name. |

The database password belongs to Hyperdrive, not Worker secrets. GitHub Actions passes production secrets to Wrangler during deployment.

## Validation

```sh
npm run lint
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

## Deployment

Production deployment is intentionally manual through the GitHub Actions `Deploy` workflow. It validates the same lint, typecheck, test, and dry-run commands before publishing.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENAI_API_KEY`
- `SENTRY_DSN`

After the first deployment, configure the domain's Cloudflare Email Routing catch-all rule to invoke `mail-app-ingest`.

See [RUNBOOK.md](RUNBOOK.md) for deployment checks, AI recovery, secret rotation, and rollback.
