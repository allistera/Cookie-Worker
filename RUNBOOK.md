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
- A scheduled or manually triggered recovery emits `ai_recovery_complete`.

Check Sentry for errors tagged with the Worker environment and processing stage.

## AI enrichment and recovery

After forwarding succeeds, the Worker starts best-effort enrichment with a fresh database client. Enrichment is AI classification only; search indexing is a separate best-effort write to Meilisearch.

The scheduled handler runs every 15 minutes. It retries up to three `pending` or `failed` rows older than two minutes.

## Search indexing

A message's search document is kept current by marking and sweeping. Any handler that changes an indexed field — flags, labels, the spam verdict — sets `messages.search_indexed_at` back to NULL in the same statement or transaction, then fires a best-effort sync that stamps it with the current time. A row whose sync never landed keeps its NULL and is repaired later.

The same 15-minute cron that recovers enrichment also sweeps up to 200 such rows. Its log events are `search_drift_swept` (with `selected`, `indexed` and `failed` counts — check `failed`, not just the presence of the line), `search_drift_sweep_failed`, and `search_drift_sweep_misconfigured`. A non-zero `failed` also raises a handled exception in Sentry under the `search_drift_sweep` operation.

Two workflows back this up: `search-drift-repair.yml` reindexes drifted rows from CI, and `search-reindex.yml` rebuilds an index from scratch. The workflow drains oldest-first while the in-Worker sweep takes newest-first, so recent mail becomes searchable quickly and a large backlog still drains from the tail.

Mail sent through Cookie-Web's `api/send.js` is indexed only by the sweep: that function runs on Vercel and has no Meilisearch client, so its rows are born NULL and wait for the next tick.

AI failures do not block forwarding or storage. Inspect the OpenAI response, rate limits, secret configuration, database connectivity, and migration state.

## Email routing

Cloudflare Email Routing must target this Worker for the intended recipient address. The Worker validates the incoming recipient against `OWNER_EMAIL`.

If messages are not stored, confirm the exact recipient address, Hyperdrive project, and current database schema. Delivery may still succeed through the forwarding fallback.

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

When rotating the database password, update the Cloudflare Hyperdrive origin and the local connection string separately.

## Incident response

For AI-only failures, leave email routing active while investigating. Disable the scheduled trigger or roll back the Worker if retries are causing load or repeated errors.

For storage or delivery failures, inspect Worker logs and Sentry first. If needed, route mail directly to the fallback mailbox while the Worker is repaired.

## Rollback

Use the Cloudflare dashboard or `npx wrangler rollback --config workers/mail-app-ingest/wrangler.jsonc` to restore the last known-good Worker version.

Avoid rolling back database migrations during an incident. The AI schema changes are additive and safe to leave in place while the Worker is reverted.
