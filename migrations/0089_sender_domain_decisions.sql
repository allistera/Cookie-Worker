-- Sender decisions can cover a whole domain. A row whose address is
-- '@example.com' applies to example.com and every subdomain of it
-- (news.example.com). An exact-address row still wins over any domain row, and
-- a more specific domain wins over its parent. Workers decide which key a
-- decision uses (public email providers stay exact-address); this migration
-- only teaches the database how to resolve them.
BEGIN;

-- The single decision that applies to a From address, or no row.
CREATE FUNCTION public.effective_sender_decision(p_user_id uuid, p_from_address text)
RETURNS TABLE (address text, decision text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT d.address, d.decision
  FROM (SELECT lower(btrim(p_from_address)) AS sender) s
  CROSS JOIN LATERAL (SELECT regexp_replace(s.sender, '^.*@', '') AS domain) dm
  JOIN public.sender_decisions d ON d.user_id = p_user_id
  WHERE d.address = s.sender
     OR (left(d.address, 1) = '@' AND position('@' IN s.sender) > 0 AND (
           dm.domain = substr(d.address, 2)
           OR right(dm.domain, length(d.address)) = '.' || substr(d.address, 2)))
  ORDER BY (d.address = s.sender) DESC, length(d.address) DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.effective_sender_decision(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.effective_sender_decision(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.screen_incoming_sender()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  sender_decision text;
  screening_enabled boolean;
BEGIN
  NEW.screening_status := 'allowed';
  IF NEW.is_sent THEN RETURN NEW; END IF;
  -- The ingest owner lock serializes these reads with settings/decision writes.
  -- Never take the responder lock inside this uncommitted arrival transaction.
  SELECT e.decision INTO sender_decision
    FROM public.effective_sender_decision(NEW.user_id, NEW.from_address) e;
  SELECT COALESCE(prefs -> 'senderScreening' = 'true'::jsonb, false)
    INTO screening_enabled FROM public.users WHERE id = NEW.user_id;
  IF sender_decision = 'blocked' THEN
    NEW.screening_status := 'blocked';
  ELSIF COALESCE(screening_enabled, false) AND sender_decision IS DISTINCT FROM 'accepted' THEN
    NEW.screening_status := 'held';
  END IF;
  IF NEW.screening_status <> 'allowed' THEN NEW.auto_reply_suppressed := true; END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A failed preference lookup must preserve storage/forwarding without exposing
  -- an unreviewed message to alerts or automatic replies. The owner can restore it.
  NEW.screening_status := 'held';
  NEW.auto_reply_suppressed := true;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE public.sender_decisions IS
  'Server-only sender decisions. address is an exact lowercased trimmed From address, or ''@domain'' covering that domain and its subdomains; exact rows win, then the longest domain. Resolve with effective_sender_decision. Workers enforce verified Auth0 owner scope.';

COMMIT;
