-- Close the one remaining gap in the table-level hardening: label_rules and
-- label_rule_conditions (migration 0029) were created with RLS enabled but
-- without the explicit REVOKE ALL PRIVILEGES FROM anon, authenticated that
-- every other table carries. RLS with no policies already blocks all access
-- through the Supabase Data API, and ALTER DEFAULT PRIVILEGES (migration
-- 0013) prevents future auto-grants — this adds the belt-and-suspenders
-- REVOKE for parity with the rest of the schema.

BEGIN;

REVOKE ALL PRIVILEGES ON TABLE public.label_rules FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.label_rule_conditions FROM anon, authenticated;

COMMIT;
