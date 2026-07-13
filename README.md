# Cookie Worker

Cookie Worker (`mail-app-ingest`) is a Cloudflare Email Worker for Cookie-Web. It
receives routed email, stores a parsed copy in Supabase through Cloudflare
Hyperdrive, and forwards the original message to the configured mailbox.

Forwarding is the priority: storage and optional embedding failures are reported
without intentionally preventing delivery. Transient forwarding failures are
re-thrown so the sending mail server can retry safely.

## What it does

- Parses incoming MIME email and attachments with `postal-mime`.
- Stores messages idempotently in the Cookie-Web database.
- Forwards the original email to `FORWARD_TO`.
- Optionally creates OpenAI embeddings after a successful insert.
- Reports sanitized failures to Sentry with Cloudflare release metadata.
- Rejects parsing for messages over 10 MiB while still forwarding them.

## Requirements

- Node.js 24+
- npm
- A Cloudflare account with Workers, Email Routing, and Hyperdrive configured
- A compatible Supabase/Postgres database

## Setup

Install dependencies:

```sh
npm install
```

Copy the local variable template:

```sh
cp .dev.vars.example .dev.vars
```

Point Wrangler at a development database through the local Hyperdrive override:

```sh
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://postgres.PROJECT_REF:password@aws-0-REGION.pooler.supabase.com:5432/postgres"
```

Never use the production database for local development.

## Configuration

| Name | Purpose |
| --- | --- |
| `HYPERDRIVE` | Database connection binding configured in `wrangler.jsonc`. |
| `FORWARD_TO` | Verified mailbox that receives the original email. |
| `OWNER_EMAIL` | Email of the Cookie-Web user that owns stored messages. |
| `OPENAI_API_KEY` | Optional; enables best-effort message embeddings. |
| `SENTRY_DSN` | Required in production; sends sanitized Worker errors to Sentry. |
| `SENTRY_ENVIRONMENT` | Sentry environment name; defaults to `production`. |

Production secrets are uploaded by the GitHub Actions deployment workflow. The
database connection string belongs to the Hyperdrive configuration and is not a
Worker secret.

## Local development

Start Wrangler:

```sh
npm run dev
```

Send the included fixture to the local email handler:

```sh
curl --request POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=inbox@example.org' \
  --data-binary @test/fixtures/simple.eml
```

Wrangler logs forwarding locally instead of delivering the message. Sending the
fixture again should produce a `duplicate` storage outcome.

## Validation

```sh
npm run lint
npm run typecheck
npm test
```

## Deployment

Production deployment is intentionally handled by the GitHub Actions `deploy`
workflow. Before deploying, configure these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SENTRY_DSN`
- `OPENAI_API_KEY` (optional)

After deployment, configure the domain's Cloudflare Email Routing catch-all rule
to send mail to the `mail-app-ingest` Worker.

See [RUNBOOK.md](RUNBOOK.md) for production verification, embedding catch-up,
secret rotation, and rollback instructions.
