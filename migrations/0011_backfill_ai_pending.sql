-- Queue existing inbound messages for the same bounded recovery sweep used by
-- new mail. Sent copies are excluded: auto-tagging and spam are inbound-only.

BEGIN;

INSERT INTO message_ai (message_id, status, provider, prompt_version)
SELECT m.id, 'pending', 'openai', 'email-enrichment-v1'
FROM messages m
WHERE NOT m.is_sent
ON CONFLICT (message_id) DO NOTHING;

COMMIT;
