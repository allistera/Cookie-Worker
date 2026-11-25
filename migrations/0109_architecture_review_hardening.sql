-- October 2026 architecture review follow-up.
--
-- 1. refresh_contact_message_projection() is SECURITY DEFINER and is only ever
--    run by messages_contact_projection_trigger (migration 0100). No Worker or
--    client calls it, so anon and authenticated must not be able to reach it
--    through /rest/v1/rpc. Trigger firing does not check EXECUTE at run time,
--    so the trigger keeps working after this revoke.
-- 2. effective_sender_decision() reads public tables and had no pinned
--    search_path. Pin it, as the other functions in this schema do.
-- 3. task_items.project_id and google_calendar_oauth_states.user_id are
--    foreign keys with no index, so deletes from their parents scan the child.
-- 4. draft_attachments and scheduled_send_attachments had no primary key.
--    Both writers assign position from the list order, so (parent, position)
--    is unique by construction; draft writes delete before reinserting.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.refresh_contact_message_projection() FROM anon, authenticated;

ALTER FUNCTION public.effective_sender_decision(uuid, text) SET search_path = pg_catalog, public;

CREATE INDEX IF NOT EXISTS task_items_project_id_idx
  ON public.task_items (project_id);

CREATE INDEX IF NOT EXISTS google_calendar_oauth_states_user_id_idx
  ON public.google_calendar_oauth_states (user_id);

ALTER TABLE public.draft_attachments
  ADD CONSTRAINT draft_attachments_pkey PRIMARY KEY (draft_id, position);

ALTER TABLE public.scheduled_send_attachments
  ADD CONSTRAINT scheduled_send_attachments_pkey PRIMARY KEY (scheduled_send_id, position);

COMMIT;
