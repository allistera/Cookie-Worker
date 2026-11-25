-- The contact projection holds addresses and names. Enable row-level security
-- with no policies, and make the contacts view run as the querying role so a
-- later grant cannot bypass the table through the view. Workers connect as
-- the table owner and still bypass row-level security.

BEGIN;

ALTER TABLE public.contact_message_projection ENABLE ROW LEVEL SECURITY;
ALTER VIEW public.contacts SET (security_invoker = true);
REVOKE ALL PRIVILEGES ON TABLE public.contact_message_projection FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.contacts FROM PUBLIC, anon, authenticated;

COMMIT;
