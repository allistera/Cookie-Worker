-- Subscriptions: the senders whose mail carries a List-Unsubscribe header, and
-- the senders the person has unsubscribed from.
--
-- sender_unsubscribes holds one row per sender address an unsubscribe was
-- confirmed for (a one-click request the sender accepted, an unsubscribe mail
-- that went out, or the AI finishing the sender's page). address is the
-- message's from_address, lower-cased and trimmed. Mail that arrives after
-- unsubscribed_at shows the sender is still sending.
--
-- messages_list_unsubscribe_idx finds the list mail without reading every
-- message's headers, which are large and stored out of line. Its predicate is
-- repeated word for word in Cookie-Worker's
-- workers/cookie-web-messages/src/subscriptions.js; change both together.
--
-- Cookie-Worker reads and writes these through its own database role; no API
-- role gets access. That Worker tolerates the table's absence, so it can be
-- deployed before or after this migration.
BEGIN;

CREATE TABLE public.sender_unsubscribes (
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  address         text NOT NULL
                    CHECK (address = lower(btrim(address)) AND length(address) BETWEEN 1 AND 320),
  method          text NOT NULL CHECK (method IN ('one-click', 'mailto', 'ai')),
  unsubscribed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, address)
);

ALTER TABLE public.sender_unsubscribes ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.sender_unsubscribes FROM PUBLIC, anon, authenticated;

CREATE INDEX messages_list_unsubscribe_idx
  ON public.messages (user_id, lower(btrim(from_address)), sent_at DESC, id DESC)
  WHERE NOT is_sent
    AND jsonb_typeof(headers) = 'array'
    AND jsonb_path_exists(headers, '$[*] ? (@.key like_regex "^list-unsubscribe$" flag "i")');

COMMIT;
