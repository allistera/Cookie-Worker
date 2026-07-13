# Cookie Worker runbook

This runbook covers deployment, verification, recovery, and rollback for the email-ingest Worker.

## Preconditions

Apply the Cookie Web migrations before deploying Worker changes that depend on them. AI enrichment requires migrations `0010` and `0011`.

Confirm the Cloudflare Worker has its email route, Hyperdrive binding, required variables, and the `OPENAI_API_KEY` and `SENTRY_DSN` secrets.

## Deploy

Run the `Deploy` workflow in GitHub Actions. It validates the Worker, uploads its secrets, and deploys with Wrangler.

For local validation before deployment:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

## Verify production

Send a message from an external account to the configured Cloudflare Email Routing address. Verify:

- The message arrives at `FORWARD_TO`.
- A row appears in `messages`, and Worker logs contain a `stored` event.
- An `ai_enriched` event is written after classification completes.
- `message_ai.status` becomes `completed`.
- Suggested tags appear in Cookie Web.
- Spam above the threshold appears in the hidden Spam folder, not the inbox.
- A scheduled or manually triggered recovery emits `ai_recovery_complete`.

Check Sentry for errors tagged with the Worker environment and processing stage.

## AI enrichment and recovery

After forwarding succeeds, the Worker starts best-effort enrichment with a fresh database client. Classification and embedding generation run concurrently.

The scheduled handler runs every 15 minutes. It retries up to three `pending` or `failed` rows older than two minutes.

Cookie Web also retains its weekly embedding backfill. That job handles older messages and records that predate immediate enrichment.

AI failures do not block forwarding or storage. Inspect the OpenAI response, rate limits, secret configuration, database connectivity, and migration state.

## Email routing

Cloudflare Email Routing must target this Worker for the intended recipient address. The Worker validates the incoming recipient against `OWNER_EMAIL`.

If messages are not stored, confirm the exact recipient address, Hyperdrive project, and current database schema. Delivery may still succeed through the forwarding fallback.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, set the documented environment values, and run:

```bash
npm install
npm run dev
```

Use a development Supabase project. Do not connect local Worker sessions to production unless the task explicitly requires it.

## Rotate credentials

Update GitHub environment secrets first, then rerun the `Deploy` workflow. Confirm the deployed Worker reports no authentication errors.

When rotating the database password, update the Cloudflare Hyperdrive origin and the local connection string separately.

## Incident response

For AI-only failures, leave email routing active while investigating. Disable the scheduled trigger or roll back the Worker if retries are causing load or repeated errors.

For storage or delivery failures, inspect Worker logs and Sentry first. If needed, route mail directly to the fallback mailbox while the Worker is repaired.

## Rollback

Use the Cloudflare dashboard or `npx wrangler rollback` to restore the last known-good Worker version.

Avoid rolling back database migrations during an incident. The AI schema changes are additive and safe to leave in place while the Worker is reverted.
