-- Read-only calendar subscriptions. A calendar with a non-null
-- subscription_url is fed entirely by periodic ICS sync (api/_lib/
-- calendarSync.js) rather than manual event CRUD — calendar-events.js
-- rejects direct writes into it. subscription_error holds the last sync
-- failure message (if any) without ever blanking previously-synced events.

BEGIN;

ALTER TABLE public.calendars
  ADD COLUMN subscription_url text CHECK (subscription_url IS NULL OR length(subscription_url) <= 2000),
  ADD COLUMN subscription_synced_at timestamptz,
  ADD COLUMN subscription_error text;

COMMIT;
