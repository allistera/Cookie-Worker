# Historical: Neon to Supabase cutover

Status: completed in July 2026.

This document records the former production migration. Do not follow it as a current operations runbook; Supabase is now the system of record.

## Current state

- Cookie-Web connects through `DATABASE_URL` using `postgres.js`.
- Cookie-Worker connects through the Cloudflare `HYPERDRIVE` binding.
- GitHub Actions uses an IPv4-reachable Supavisor session-pooler URL.
- Supabase Postgres stores messages, labels, AI state, and pgvector embeddings.
- Supabase Realtime sends content-free inbox refresh notifications.

## Cutover method retained for reference

The original move paused the Cloudflare email route, copied and verified data, repointed Vercel and Hyperdrive, tested the full mail path, and then restored routing.

Ingestion was idempotent on `(user_id, message_id)`, so sender retries and duplicate inserts were safe during the short pause.

## Historical rollback boundary

Rollback to Neon was safe only while Neon remained current. Messages accepted after the Supabase cutover would have required reverse copying before a late rollback.

Neon is no longer an active target. New migration, recovery, and incident procedures should use Supabase and the current Cookie-Worker runbook.
