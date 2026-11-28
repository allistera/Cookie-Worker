-- Automations: work Cookie does for a person on a schedule, and a record of
-- each time it ran.
--
-- automations holds one row per automation. handler names the built-in job it
-- runs (cookie-web-automations' src/handlers.js lists them); trigger says
-- when, as {"type": "schedule", "time": "HH:MM", "days": [...],
-- "timeZone": "<IANA zone>"}. next_run_at is the next instant that trigger
-- falls on, worked out by the Worker whenever the row is saved or claimed for
-- a run, so the cron tick finds what is due with one indexed read. It is null
-- while the automation is switched off.
--
-- automation_runs holds one row per run, written as 'running' when the run is
-- claimed and settled when it ends. A run that never settles (the invocation
-- died) is marked failed by a later tick.
--
-- Cookie-Worker reads and writes these through its own database role; no API
-- role gets access.
BEGIN;

CREATE TABLE public.automations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  handler     text NOT NULL CHECK (length(handler) BETWEEN 1 AND 60),
  trigger     jsonb NOT NULL CHECK (jsonb_typeof(trigger) = 'object'),
  enabled     boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.automations FROM PUBLIC, anon, authenticated;

CREATE INDEX automations_user_idx ON public.automations (user_id, created_at);
CREATE INDEX automations_due_idx ON public.automations (next_run_at)
  WHERE enabled AND next_run_at IS NOT NULL;

CREATE TABLE public.automation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  trigger       text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'succeeded', 'failed')),
  summary       text NOT NULL DEFAULT '' CHECK (length(summary) <= 500),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.automation_runs FROM PUBLIC, anon, authenticated;

CREATE INDEX automation_runs_user_idx ON public.automation_runs (user_id, started_at DESC);
CREATE INDEX automation_runs_running_idx ON public.automation_runs (started_at)
  WHERE status = 'running';

COMMIT;
