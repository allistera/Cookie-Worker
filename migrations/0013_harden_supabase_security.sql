-- Close the Supabase Data API path to application data. Cookie-Web and the
-- ingestion worker access Postgres through server-side connections; the
-- browser Supabase client is used only for content-free Realtime broadcasts.

BEGIN;

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_ai ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.attachments,
  public.labels,
  public.message_ai,
  public.message_labels,
  public.messages,
  public.schema_migrations,
  public.threads,
  public.users
FROM anon, authenticated;

-- Supabase grants new public tables to its API roles by default. Keep future
-- server-only tables private unless a later migration deliberately grants
-- access and adds an RLS policy.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;

-- The trigger uses only pg_catalog built-ins and the explicitly-qualified
-- realtime.send function, so it does not need a mutable caller search path.
ALTER FUNCTION public.notify_inbox_changed() SET search_path = pg_catalog;

-- Keep extension objects out of the Data API's exposed public schema.
CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION vector SET SCHEMA extensions;

COMMIT;
