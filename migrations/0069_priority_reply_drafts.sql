BEGIN;

-- A completed/skipped marker outlives the draft, so sending or discarding it
-- never causes a background retry to recreate it. Attempts lease AI work.
ALTER TABLE public.message_ai
  ADD COLUMN reply_draft_status text NOT NULL DEFAULT 'pending'
    CHECK (reply_draft_status IN ('pending', 'generating', 'completed', 'skipped', 'failed')),
  ADD COLUMN reply_draft_attempts smallint NOT NULL DEFAULT 0
    CHECK (reply_draft_attempts BETWEEN 0 AND 3),
  ADD COLUMN reply_draft_updated_at timestamptz;

CREATE INDEX message_ai_reply_draft_pending_idx
  ON public.message_ai (reply_draft_updated_at, message_id)
  WHERE status = 'completed' AND priority = 'high' AND spam_verdict = 'inbox'
    AND reply_draft_status IN ('pending', 'generating', 'failed') AND reply_draft_attempts < 3;

ALTER TABLE public.drafts ADD COLUMN is_ai_generated boolean NOT NULL DEFAULT false;
CREATE INDEX drafts_reply_to_message_idx ON public.drafts (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

-- Reuse the inbox's content-free refresh signal; no email/draft content is
-- broadcast. Only initial AI draft creation pings, not every autosave.
CREATE FUNCTION public.notify_priority_reply_draft()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object('op', 'UPDATE'), 'inbox-changed',
      'inbox:' || NEW.user_id::text, false
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER drafts_notify_priority_reply
  AFTER INSERT ON public.drafts FOR EACH ROW
  WHEN (NEW.is_ai_generated)
  EXECUTE FUNCTION public.notify_priority_reply_draft();

COMMIT;
