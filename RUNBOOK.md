# mail-app-ingest Runbook

## Deploy

Deploys are intentionally GitHub Actions-only. Use the `deploy` workflow dispatch after CI passes. Required repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `DATABASE_URL`
- `OPENAI_API_KEY` (optional, enables v1.1 embeddings)

## Email Routing Setup

In Cloudflare Email Routing, verify `FORWARD_TO`, then set the domain catch-all rule to send to the `mail-app-ingest` Worker.

## Local Development

Copy `.dev.vars.example` to `.dev.vars` and point `DATABASE_URL` at the dedicated Neon dev branch.

```sh
npm run dev
curl --request POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=sender@example.com' \
  --url-query 'to=inbox@example.org' \
  --data-binary @test/fixtures/simple.eml
```

Wrangler prints the forward call locally instead of delivering mail. Re-posting the same fixture should log `"outcome":"duplicate"`.

## Verify Production

Send a message from an external mailbox to any address at the routed domain. Confirm:

- Delivery arrives at `FORWARD_TO`.
- A `messages` row appears in Cookie-Web.
- `wrangler tail mail-app-ingest` shows `{"event":"stored","outcome":"inserted"}`.
- When `OPENAI_API_KEY` is configured, a later `{"event":"embedded"}` log appears and `messages.embedding` is not null.

## Embedding Catch-Up

Rows where `embedding IS NULL` are handled by Cookie-Web's Backfill Embeddings workflow. This Worker does not run a retry queue.

## Rollback

Run `npx wrangler rollback`, or change the Email Routing catch-all back to plain forwarding. Mail should continue flowing either way.
