-- Senders the owner marked "Not important" from the reader. Classification
-- (Cookie-Worker mail-app-ingest) never rates their mail high priority or
-- files it in a category named Important. Addresses are stored the way
-- sender matching reads them: lower(btrim(from_address)).
BEGIN;

CREATE TABLE public.sender_importance_feedback (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  address text NOT NULL CHECK (address = lower(btrim(address)) AND address <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, address)
);

ALTER TABLE public.sender_importance_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.sender_importance_feedback FROM anon, authenticated;

COMMIT;
