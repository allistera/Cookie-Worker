-- 0015_clear_enrichment_summaries.sql
-- Enrichment v1 wrote an AI summary for every inbound message; summaries are
-- now generated only when the user requests one in the reader (Cookie-Worker
-- email-enrichment-v2 stopped writing them). Clear the auto-generated
-- backlog so the reader shows summaries only after an explicit request.

BEGIN;

UPDATE message_ai SET summary = NULL, updated_at = now()
WHERE summary IS NOT NULL;

COMMIT;
