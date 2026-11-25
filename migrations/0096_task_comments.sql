-- 0096_task_comments.sql
-- A discussion thread on each task: one row per entry, in time order,
-- holding text, an attached file, or both. cookie-web-tasks
-- (src/taskComments.js) serves them under /task-comments. An attachment's
-- bytes live in the private R2 bucket cookie-files under object_key, as
-- document_files (0076) keeps uploads; the row holds only the name, type
-- and size. user_id is the author, and only the author may edit or delete
-- an entry. task_id cascades, so a task (or its project) going takes the
-- thread with it; the Worker removes the objects of the rows that vanished.

BEGIN;

CREATE TABLE public.task_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES public.task_items(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body        text NOT NULL DEFAULT '',
  file_name   text,
  mime_type   text,
  size_bytes  bigint,
  object_key  text UNIQUE,
  edited_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- An entry says something or carries something; never neither.
  CONSTRAINT task_comments_has_content CHECK (body <> '' OR object_key IS NOT NULL),
  -- The four attachment columns are set together or not at all.
  CONSTRAINT task_comments_attachment_complete CHECK (
    (object_key IS NULL) = (file_name IS NULL)
    AND (object_key IS NULL) = (mime_type IS NULL)
    AND (object_key IS NULL) = (size_bytes IS NULL)
  )
);

-- The thread reads oldest first and pages on (created_at, id).
CREATE INDEX task_comments_task_idx ON public.task_comments (task_id, created_at, id);

-- The Worker lists an owner's attachment keys before and after a delete
-- that cascades here, to remove the objects of the rows that went.
CREATE INDEX task_comments_attachments_idx
  ON public.task_comments (user_id) WHERE object_key IS NOT NULL;

ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.task_comments FROM anon, authenticated;

COMMIT;
