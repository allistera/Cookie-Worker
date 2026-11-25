-- Private, user-owned contact context shown beside an open email.

BEGIN;

CREATE TABLE public.contact_insights (
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  address      text NOT NULL,
  company      text,
  role         text,
  linkedin_url text,
  notes        text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, address),
  CHECK (address = lower(btrim(address))),
  CHECK (char_length(address) <= 320),
  CHECK (company IS NULL OR char_length(company) <= 200),
  CHECK (role IS NULL OR char_length(role) <= 200),
  CHECK (linkedin_url IS NULL OR char_length(linkedin_url) <= 500),
  CHECK (char_length(notes) <= 10000)
);

ALTER TABLE public.contact_insights ENABLE ROW LEVEL SECURITY;

CREATE INDEX messages_contact_from_idx
  ON public.messages (user_id, lower(btrim(from_address)), sent_at DESC, id DESC)
  WHERE NOT is_deleted;

REVOKE ALL PRIVILEGES ON TABLE public.contact_insights FROM anon, authenticated;

COMMIT;
