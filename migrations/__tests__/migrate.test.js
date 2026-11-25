import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'migrations/migrate.sh');

// Stand-in psql: answers the "already applied?" probe from $APPLIED and logs
// the args + stdin of every script run so the test can inspect what would
// have reached the database.
const FAKE_PSQL = `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"SELECT 1 FROM schema_migrations"* ]]; then
  for applied in $APPLIED; do
    [[ "$args" == *"'$applied'"* ]] && echo 1
  done
  exit 0
fi
if [[ "$args" == *"-f -"* ]]; then
  { echo "ARGS: $args"; cat; echo "--- END"; } >> "$PSQL_LOG"
fi
`;

describe('migrations/migrate.sh', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migrate-'));
    copyFileSync(SCRIPT, join(dir, 'migrate.sh'));
    writeFileSync(join(dir, 'psql'), FAKE_PSQL);
    chmodSync(join(dir, 'psql'), 0o755);
    writeFileSync(join(dir, '0001_done.sql'), 'BEGIN;\nSELECT 1;\nCOMMIT;\n');
    writeFileSync(
      join(dir, '0002_new.sql'),
      [
        'BEGIN;',
        'CREATE TABLE t (id int);',
        'DO $$',
        'BEGIN',
        '  PERFORM 1;',
        'END;',
        '$$;',
        'COMMIT;',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(databaseUrl = 'postgres://fake') {
    const log = join(dir, 'psql.log');
    writeFileSync(log, '');
    const out = execFileSync('bash', [join(dir, 'migrate.sh')], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DATABASE_URL: databaseUrl,
        APPLIED: '0001_done.sql',
        PSQL_LOG: log,
      },
      encoding: 'utf8',
    });
    return { out, log: readFileSync(log, 'utf8') };
  }

  it('applies each pending migration and its marker in one locked transaction', () => {
    const { out, log } = run();

    expect(out).toContain('skip   0001_done.sql');
    expect(out).toContain('apply  0002_new.sql');
    expect(out).toContain('done: 1 applied, 1 skipped');

    const scripts = log.split('--- END').filter((s) => s.trim());
    expect(scripts).toHaveLength(1);
    const [script] = scripts;
    expect(script).toContain('--single-transaction');
    expect(script).toContain('ON_ERROR_STOP=1');

    const body = script.split('\n').slice(1).join('\n');
    // Lock first, then the marker, then the migration body - all in the same
    // psql --single-transaction run.
    expect(body.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      body.indexOf("INSERT INTO schema_migrations (filename) VALUES ('0002_new.sql');"),
    );
    expect(body.indexOf('INSERT INTO schema_migrations')).toBeLessThan(
      body.indexOf('CREATE TABLE t'),
    );
    // Timeouts are transaction-scoped, set after the runner lock (so waiting
    // on another runner is not cut short) and before the migration body.
    const lockAt = body.indexOf('pg_advisory_xact_lock');
    const bodyAt = body.indexOf('CREATE TABLE t');
    for (const setting of ["SET LOCAL lock_timeout = '5s';", 'SET LOCAL statement_timeout =']) {
      expect(body.indexOf(setting)).toBeGreaterThan(lockAt);
      expect(body.indexOf(setting)).toBeLessThan(bodyAt);
    }
    // The file's own top-level transaction lines are stripped so they cannot
    // commit early; the plpgsql block keeps its BEGIN/END.
    expect(body).not.toMatch(/^BEGIN;$/m);
    expect(body).not.toMatch(/^COMMIT;$/m);
    expect(body).toMatch(/^BEGIN$/m);
    expect(body).toMatch(/^END;$/m);
  });

  // psql rejects a URI parameter it does not know, and Supabase's dashboard
  // puts `supa=base-pooler.x` on its pooler strings.
  it.each([
    ['postgres://u:p@host:5432/db?supa=base-pooler.x', 'postgres://u:p@host:5432/db'],
    [
      'postgres://u:p@host:5432/db?supa=base-pooler.x&sslmode=require',
      'postgres://u:p@host:5432/db?sslmode=require',
    ],
    [
      'postgres://u:p@host:5432/db?sslmode=require&supa=base-pooler.x',
      'postgres://u:p@host:5432/db?sslmode=require',
    ],
    ['postgres://u:p@host:5432/db?sslmode=require', 'postgres://u:p@host:5432/db?sslmode=require'],
  ])('connects with %j as %j', (databaseUrl, expected) => {
    const { log } = run(databaseUrl);

    expect(log).toContain(`ARGS: ${expected} -v ON_ERROR_STOP=1`);
  });

  it.each(['begin;', 'COMMIT; -- done', 'BEGIN TRANSACTION;', 'COMMIT WORK;', 'ROLLBACK;'])(
    'refuses a migration with stray transaction control %j',
    (line) => {
      writeFileSync(join(dir, '0002_new.sql'), `${line}\nCREATE TABLE t (id int);\n`);

      let error;
      try {
        run();
      } catch (err) {
        error = err;
      }

      expect(error?.status).toBe(1);
      expect(error.stderr).toContain('0002_new.sql');
      expect(readFileSync(join(dir, 'psql.log'), 'utf8')).toBe('');
    },
  );
});
