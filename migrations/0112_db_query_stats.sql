-- Database health check support for Cookie-Worker's mail-app-ingest cron.
--
-- db_query_stats is the previous reading of pg_stat_statements: one row per
-- statement with its call count and total execution time as of the last
-- 15-minute tick. The cron compares the live counters with it to find
-- statements that have become slower than their own history, then replaces
-- it. It holds counters only, never query text, and nothing reads it but
-- that check, so no API role gets access.
--
-- The role settings make Postgres log every statement that takes a second or
-- longer, with its plan, into the project's own Postgres logs. Both parameter
-- settings are zero so the values bound to a logged statement (mail content,
-- addresses) are never written there. They are set on the role the migration
-- runs as, which is the role the Workers connect with, and take effect for
-- new sessions. To undo: ALTER ROLE <role> RESET <setting>.
BEGIN;

CREATE TABLE public.db_query_stats (
  queryid bigint PRIMARY KEY,
  calls bigint NOT NULL,
  total_ms double precision NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.db_query_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.db_query_stats FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  EXECUTE format('ALTER ROLE %I SET log_min_duration_statement = %L', current_user, '1000');
  EXECUTE format('ALTER ROLE %I SET log_parameter_max_length = %L', current_user, '0');
  EXECUTE format('ALTER ROLE %I SET auto_explain.log_min_duration = %L', current_user, '1000');
  EXECUTE format('ALTER ROLE %I SET auto_explain.log_parameter_max_length = %L', current_user, '0');
END
$$;

COMMIT;
