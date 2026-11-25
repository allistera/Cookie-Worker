-- Keep one durable scheduled delivery per client request, including retries
-- after an uncertain response; legacy clients may omit the request id.
BEGIN;

ALTER TABLE public.scheduled_sends
  ADD COLUMN request_id text,
  ADD COLUMN request_hash text,
  ADD CONSTRAINT scheduled_sends_request_check CHECK (
    (request_id IS NULL AND request_hash IS NULL) OR
    (request_id IS NOT NULL AND request_hash IS NOT NULL AND request_id ~ '^[A-Za-z0-9._:-]{1,128}$' AND request_hash ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX scheduled_sends_user_request_idx
  ON public.scheduled_sends (user_id, request_id) WHERE request_id IS NOT NULL;

COMMIT;
