-- Keep live conversation summaries separate from per-message AI enrichment.
BEGIN;

ALTER TABLE public.threads
  ADD COLUMN ai_summary text,
  ADD COLUMN ai_summary_message_id uuid,
  ADD COLUMN ai_summary_updated_at timestamptz;

COMMENT ON COLUMN public.threads.ai_summary IS
  'One-line AI summary of the thread through ai_summary_message_id.';
COMMENT ON COLUMN public.threads.ai_summary_message_id IS
  'Newest non-deleted message included in ai_summary; a different latest message makes it stale.';

COMMIT;
