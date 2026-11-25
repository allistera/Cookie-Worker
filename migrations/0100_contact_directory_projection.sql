-- Keep the expensive JSON recipient expansion out of the contacts read path.
-- Each live message contributes at most one row per normalized address.
BEGIN;

CREATE TABLE public.contact_message_projection (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  address text NOT NULL,
  name text,
  PRIMARY KEY (message_id, address)
);

CREATE INDEX contact_message_projection_user_address_idx
  ON public.contact_message_projection (user_id, address);

CREATE OR REPLACE FUNCTION public.refresh_contact_message_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.contact_message_projection WHERE message_id = OLD.id;
    RETURN OLD;
  END IF;

  DELETE FROM public.contact_message_projection WHERE message_id = NEW.id;
  IF NOT NEW.is_deleted THEN
    INSERT INTO public.contact_message_projection (user_id, message_id, address, name)
    SELECT NEW.user_id, NEW.id, addr.address,
           CASE WHEN NOT NEW.is_sent THEN nullif(btrim(NEW.from_name), '') END
    FROM (
      SELECT DISTINCT lower(btrim(
        CASE WHEN jsonb_typeof(rcpt.value) = 'string' THEN rcpt.value #>> '{}'
             ELSE rcpt.value->>'address' END
      )) AS address
      FROM jsonb_array_elements(
        coalesce(NEW.recipients->'to', '[]'::jsonb)
        || coalesce(NEW.recipients->'cc', '[]'::jsonb)
        || coalesce(NEW.recipients->'bcc', '[]'::jsonb)
      ) AS rcpt(value)
      WHERE NEW.is_sent
      UNION
      SELECT lower(btrim(NEW.from_address)) WHERE NOT NEW.is_sent
    ) AS addr
    WHERE nullif(addr.address, '') IS NOT NULL
    ON CONFLICT (message_id, address) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          name = coalesce(contact_message_projection.name, EXCLUDED.name);
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO public.contact_message_projection (user_id, message_id, address, name)
SELECT m.user_id, m.id, addr.address,
       CASE WHEN NOT m.is_sent THEN nullif(btrim(m.from_name), '') END
FROM public.messages m
CROSS JOIN LATERAL (
  SELECT DISTINCT lower(btrim(
    CASE WHEN jsonb_typeof(rcpt.value) = 'string' THEN rcpt.value #>> '{}'
         ELSE rcpt.value->>'address' END
  )) AS address
  FROM jsonb_array_elements(
    coalesce(m.recipients->'to', '[]'::jsonb)
    || coalesce(m.recipients->'cc', '[]'::jsonb)
    || coalesce(m.recipients->'bcc', '[]'::jsonb)
  ) AS rcpt(value)
  WHERE m.is_sent
  UNION
  SELECT lower(btrim(m.from_address)) WHERE NOT m.is_sent
) addr
WHERE NOT m.is_deleted AND nullif(addr.address, '') IS NOT NULL
ON CONFLICT (message_id, address) DO UPDATE
  SET name = coalesce(contact_message_projection.name, EXCLUDED.name);

DROP TRIGGER IF EXISTS messages_contact_projection_trigger ON public.messages;
CREATE TRIGGER messages_contact_projection_trigger
AFTER INSERT OR UPDATE OF user_id, is_sent, is_deleted, from_address, from_name, recipients
OR DELETE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.refresh_contact_message_projection();

CREATE OR REPLACE VIEW public.contacts AS
SELECT p.user_id, p.address,
       (array_agg(p.name) FILTER (WHERE p.name IS NOT NULL))[1] AS name
FROM public.contact_message_projection p
JOIN public.users u ON u.id = p.user_id
WHERE p.address <> lower(u.email)
GROUP BY p.user_id, p.address;

REVOKE ALL PRIVILEGES ON TABLE public.contacts FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.contact_message_projection FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_contact_message_projection() FROM PUBLIC;
COMMIT;
