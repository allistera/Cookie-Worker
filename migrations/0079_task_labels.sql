-- 0079_task_labels.sql
-- Managed task labels. task_items.labels (0067) keeps holding label names;
-- this table gives each name a row of its own so it can carry a colour and
-- be listed, renamed and deleted across every task that uses it. Keyed by
-- (user_id, name) rather than referenced by id, so nothing that reads or
-- writes task_items.labels has to change.

BEGIN;

CREATE TABLE public.task_labels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  color      text NOT NULL DEFAULT '#64748b',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name),
  -- Mirrors the Worker's normalizeTaskLabels: lowercase, 1-40 characters,
  -- no whitespace, @ or #.
  CONSTRAINT task_labels_name_check
    CHECK (name ~ '^[^[:space:]@#]{1,40}$' AND name = lower(name)),
  CONSTRAINT task_labels_color_check CHECK (color ~ '^#[0-9a-f]{6}$')
);

ALTER TABLE public.task_labels ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.task_labels FROM anon, authenticated;

-- The label view filters with labels @> ARRAY[name].
CREATE INDEX task_items_labels_idx ON public.task_items USING gin (labels);

-- Every name already on a task gets a row, so the sidebar is populated on
-- first load and a rename never meets a name it does not know.
INSERT INTO public.task_labels (user_id, name)
SELECT DISTINCT t.user_id, l.name
FROM public.task_items t, unnest(t.labels) AS l(name)
ON CONFLICT (user_id, name) DO NOTHING;

COMMIT;
