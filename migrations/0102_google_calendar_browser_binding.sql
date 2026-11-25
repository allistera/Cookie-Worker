-- Bind Google linking to both the authenticated Cookie account and the
-- initiating browser. Old in-flight states fail closed and can be restarted.
BEGIN;

ALTER TABLE public.google_calendar_oauth_states
  ADD COLUMN browser_challenge text CHECK (browser_challenge ~ '^[0-9a-f]{64}$'),
  ADD COLUMN completion_hash text CHECK (completion_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN code_encrypted text;

CREATE UNIQUE INDEX google_calendar_oauth_completion_idx
  ON public.google_calendar_oauth_states (completion_hash)
  WHERE completion_hash IS NOT NULL;

COMMIT;
