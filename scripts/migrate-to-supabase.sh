#!/usr/bin/env bash
# One-shot data migration from Neon to Supabase (schema + data via pg_dump).
#
# Usage:
#   NEON_DATABASE_URL=postgres://...  \
#   SUPABASE_DATABASE_URL=postgres://... \
#   ./scripts/migrate-to-supabase.sh
#
# SUPABASE_DATABASE_URL must be the DIRECT connection (db.<ref>.supabase.co:5432),
# not the Supavisor pooler — pg_restore needs full session semantics.
# See migrations/supabase-cutover.md for the full cutover order.
set -euo pipefail
# The dump holds the full production database: keep it readable only by the
# operator, inside a private directory, and delete it on exit by default.
umask 077

: "${NEON_DATABASE_URL:?source (Neon) connection string required}"
: "${SUPABASE_DATABASE_URL:?target (Supabase) DIRECT 5432 connection string required}"

for cmd in pg_dump pg_restore psql; do
  command -v "$cmd" >/dev/null || { echo "$cmd not found on PATH"; exit 1; }
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# mktemp -d fails if the path already exists, so the dump can never land in
# a pre-created (and possibly attacker-controlled) directory under /tmp.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cookie-web-migrate.XXXXXXXX")"
DUMP="${WORKDIR}/cookie-web-${STAMP}.dump"
LIST="${WORKDIR}/restore.list"

# Set KEEP_DUMP=1 to retain the dump for post-cutover inspection; anything
# else removes it when the script exits for any reason.
cleanup() {
  if [ "${KEEP_DUMP:-0}" = "1" ]; then
    echo "KEEP_DUMP=1: dump retained at ${DUMP}"
    return
  fi
  rm -f "$DUMP" "$LIST"
  rmdir "$WORKDIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "== 1/4 prepare target: enable extensions"
psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'

echo "== 2/4 dump source -> ${DUMP}"
pg_dump "$NEON_DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file "$DUMP"

echo "== 3/4 restore into target"
# Drop only the COMMENT ON EXTENSION entries from the restore list: those are
# the benign non-superuser errors Supabase used to surface on restore, and
# --exit-on-error below treats any remaining error as fatal. The app's own
# COMMENT ON COLUMN documentation (e.g. 0072, 0082) is still restored.
pg_restore --list "$DUMP" | grep -v ' COMMENT - EXTENSION ' > "$LIST"
# --single-transaction (which implies --exit-on-error) makes any error fatal
# and rolls the whole restore back, so a failed run leaves the target empty
# and safe to retry instead of half-populated.
pg_restore --dbname "$SUPABASE_DATABASE_URL" --no-owner --no-privileges \
  --single-transaction --exit-on-error --use-list "$LIST" "$DUMP"

echo "== 4/4 verify row counts"
fail=0
# Verify every public table present in the source, not a hand-picked subset:
# the dump is full-schema, so anything it restored must match row for row.
# The list is captured first (not fed through process substitution) so a
# failing query aborts under set -e instead of silently verifying nothing.
tables="$(psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -tA \
  -c "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename")"
if [ -z "$tables" ]; then
  echo "no public tables found in source — refusing to report success"
  exit 1
fi
while IFS= read -r t; do
  src="$(psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "SELECT count(*) FROM public.\"$t\"")"
  dst="$(psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "SELECT count(*) FROM public.\"$t\"")"
  if [ "$src" = "$dst" ]; then
    echo "ok     $t: $src"
  else
    echo "MISMATCH $t: source=$src target=$dst"
    fail=1
  fi
done <<<"$tables"

psql "$SUPABASE_DATABASE_URL" -q -c 'ANALYZE;'

if [ "$fail" -ne 0 ]; then
  echo "row counts differ — do NOT cut over; investigate before retrying"
  exit 1
fi
echo "done"
