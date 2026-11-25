BEGIN;

-- Counts failed classification runs so mail-app-ingest's recovery sweep stops
-- retrying a message after three failures. Every run spends a slot of the
-- shared daily inbound AI budget, so a permanently failing row must not keep
-- starving new mail of classification.
ALTER TABLE public.message_ai
  ADD COLUMN enrichment_attempts smallint NOT NULL DEFAULT 0
    CHECK (enrichment_attempts >= 0);

COMMIT;
