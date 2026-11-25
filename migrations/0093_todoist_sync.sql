-- Todoist sync for the Tasks app (Cookie-Worker's cookie-web-tasks,
-- src/todoistSync.js + src/todoistSettings.js). One connection per user: the
-- personal API token encrypted with AES-256-GCM under the Worker's
-- TODOIST_TOKEN_ENCRYPTION_KEY secret, the Todoist account's email and time
-- zone for display and scheduling, whether the hourly sync is switched on,
-- and what happened last time it ran so Settings can say so without a
-- Todoist round trip.
--
-- The sync is one-way: Todoist projects, sections (as dividers) and open
-- tasks are mirrored into task_projects and task_items, each mirror keyed by
-- its Todoist id so a later run updates the same row. A Cookie-authored row
-- has a null todoist_id and is never touched by the sync. The partial unique
-- indexes are what the Worker's INSERT ... ON CONFLICT upserts target.
--
-- Follows the 0013 hardening: RLS enabled, app roles revoked, access only
-- through backend connections.

BEGIN;

CREATE TABLE public.todoist_connections (
  user_id             uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  api_token_encrypted text NOT NULL,
  -- The token's last few characters, so Settings can show which token is
  -- saved without ever decrypting it for the browser.
  token_hint          text NOT NULL DEFAULT '' CHECK (length(token_hint) <= 8),
  -- Which Todoist account the token belongs to, so saving a token for a
  -- different account can unlink the previous account's mirrors first.
  todoist_user_id     text CHECK (todoist_user_id IS NULL OR length(todoist_user_id) <= 64),
  todoist_email       text CHECK (todoist_email IS NULL OR length(todoist_email) <= 320),
  time_zone           text CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 100),
  enabled             boolean NOT NULL DEFAULT true,
  last_synced_at      timestamptz,
  last_sync_status    text CHECK (last_sync_status IS NULL OR last_sync_status IN ('ok', 'failed')),
  last_sync_error     text CHECK (last_sync_error IS NULL OR length(last_sync_error) <= 500),
  last_sync_summary   jsonb CHECK (last_sync_summary IS NULL OR jsonb_typeof(last_sync_summary) = 'object'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.todoist_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.todoist_connections FROM anon, authenticated;

ALTER TABLE public.task_projects
  ADD COLUMN todoist_id text
    CONSTRAINT task_projects_todoist_id_check
    CHECK (todoist_id IS NULL OR length(todoist_id) BETWEEN 1 AND 64);

CREATE UNIQUE INDEX task_projects_todoist_idx
  ON public.task_projects (user_id, todoist_id)
  WHERE todoist_id IS NOT NULL;

-- Tasks carry the Todoist task id; a section mirrored as a divider carries
-- `section:<id>` so the two id spaces can never collide.
ALTER TABLE public.task_items
  ADD COLUMN todoist_id text
    CONSTRAINT task_items_todoist_id_check
    CHECK (todoist_id IS NULL OR length(todoist_id) BETWEEN 1 AND 80);

CREATE UNIQUE INDEX task_items_todoist_idx
  ON public.task_items (user_id, todoist_id)
  WHERE todoist_id IS NOT NULL;

COMMIT;
