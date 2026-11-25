-- Expand phase for user-managed calendars. This creates and seeds calendar
-- rows while preserving the legacy calendar_events slugs, so both the old
-- and new application versions work regardless of whether Vercel or the
-- migration workflow finishes first. Migration 0024 performs the contract.

BEGIN;

CREATE TABLE public.calendars (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  color      text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name),
  UNIQUE (user_id, id)
);

ALTER TABLE public.calendars ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.calendars FROM anon, authenticated;

-- Seed the five calendars the client used to hardcode for every user. The API
-- repeats this idempotently for users created after the migration runs.
INSERT INTO public.calendars (user_id, name, color)
SELECT u.id, d.name, d.color
FROM public.users u
CROSS JOIN (VALUES
  ('Work', '#4f7c6b'),
  ('Personal', '#2db985'),
  ('Focus time', '#795da8'),
  ('Birthdays', '#d8953b'),
  ('Holidays', '#d15c4e')
) AS d(name, color)
ON CONFLICT (user_id, name) DO NOTHING;

-- New code writes calendar UUIDs while old code continues to write slugs
-- during rollout. The contract migration normalizes both forms afterward.
ALTER TABLE public.calendar_events DROP CONSTRAINT calendar_events_calendar_check;

COMMIT;
