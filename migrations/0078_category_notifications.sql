-- Category notification preferences apply to both browser and ntfy alerts.
-- Existing and newly-created categories remain enabled unless the owner opts out.
BEGIN;

ALTER TABLE public.email_categories
  ADD COLUMN notifications_enabled boolean NOT NULL DEFAULT true;

COMMIT;
