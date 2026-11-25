#!/usr/bin/env bash
# Applies pending SQL migrations, in filename order, against $DATABASE_URL.
# Applied filenames are tracked in the schema_migrations table so re-runs
# are no-ops.
#
# Each migration runs in ONE transaction together with its schema_migrations
# marker, so a crash can never leave a migration applied but unrecorded (or
# recorded but unapplied). The files carry their own top-level `BEGIN;` /
# `COMMIT;` lines; those are stripped (only exact column-0 lines, so plpgsql
# `BEGIN`/`END;` blocks are untouched) and psql --single-transaction wraps
# the whole script instead. Any other top-level transaction-control line
# aborts the run before anything is sent. A transaction-scoped advisory lock serialises
# concurrent runners (it is safe behind Supabase's transaction pooler), and
# the marker is inserted first, so a runner that lost the race fails on the
# primary key and rolls back instead of applying the migration twice.
#
# After the advisory lock, the runner sets transaction-scoped lock and
# statement timeouts, so hot-table DDL (ALTER TABLE / CREATE INDEX on
# messages) fails fast instead of queueing behind, and then blocking, ingest
# and inbox reads. The lock is taken first so a runner waiting on another
# runner is not cut off by lock_timeout. A migration that legitimately needs
# longer can raise them itself with `SET LOCAL statement_timeout = ...;` at
# the top of its body. CREATE INDEX CONCURRENTLY cannot run inside this
# transaction: build such an index by hand first, outside a transaction
# (psql "$DATABASE_URL" -c "SET lock_timeout = '5s'; CREATE INDEX
# CONCURRENTLY IF NOT EXISTS ..."; drop and retry if it is left INVALID),
# then commit a migration with the matching plain `CREATE INDEX IF NOT
# EXISTS`, which is a no-op when the runner reaches it.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

MIGRATIONS_DIR="$(cd "$(dirname "$0")" && pwd)"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q)

# Arbitrary constant shared by every runner of this script.
LOCK_KEY=727170101

LOCK_TIMEOUT='5s'
STATEMENT_TIMEOUT='5min'

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);"

applied=0
skipped=0
for file in "$MIGRATIONS_DIR"/[0-9]*.sql; do
  [ -e "$file" ] || continue
  name="$(basename "$file")"
  already="$("${PSQL[@]}" -tA -c "SELECT 1 FROM schema_migrations WHERE filename = '$name';")"
  if [ "$already" = "1" ]; then
    echo "skip   $name (already applied)"
    skipped=$((skipped + 1))
    continue
  fi
  body="$(sed -E '/^(BEGIN|COMMIT);[[:space:]]*$/d' "$file")"
  # Any other spelling of transaction control (`begin;`, `COMMIT; -- x`,
  # `BEGIN TRANSACTION;`, `ROLLBACK;`, ...) would end the wrapping transaction
  # early and record the marker with only part of the migration applied, so
  # refuse to run the file. plpgsql `BEGIN` (no semicolon) and `END;` pass.
  if bad="$(grep -inE '^[[:space:]]*(begin[[:space:]]*(;|transaction|work|isolation)|start[[:space:]]+transaction|(commit|rollback|abort)([[:space:]]|;|$)|end[[:space:]]+(transaction|work))' <<<"$body")"; then
    echo "error  $name: transaction control must be a bare column-0 'BEGIN;' / 'COMMIT;' line:" >&2
    echo "$bad" >&2
    exit 1
  fi
  echo "apply  $name"
  {
    echo "SELECT pg_advisory_xact_lock($LOCK_KEY);"
    echo "SET LOCAL lock_timeout = '$LOCK_TIMEOUT';"
    echo "SET LOCAL statement_timeout = '$STATEMENT_TIMEOUT';"
    echo "INSERT INTO schema_migrations (filename) VALUES ('$name');"
    printf '%s\n' "$body"
  } | "${PSQL[@]}" --single-transaction -f - >/dev/null
  applied=$((applied + 1))
done

echo "done: $applied applied, $skipped skipped"
