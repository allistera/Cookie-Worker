import {
  decodeCursor,
  encodeCursor,
  timestamp,
  validId,
  validTimestamp,
} from '../../../shared/pagination.js';

const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

function noStore(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, { status: response.status, headers });
}

export function normalizeContactAddress(value) {
  const address = String(value ?? '')
    .trim()
    .toLowerCase();
  return address.length <= 320 && ADDRESS_RE.test(address) ? address : null;
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('Contact fields must be text');
  const text = value.trim();
  if (text.length > maxLength) throw new Error('Contact field is too long');
  return text || null;
}

function notesText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new Error('Notes must be text');
  if (value.length > 10000) throw new Error('Notes are too long');
  return value;
}

function linkedinUrl(value) {
  const text = optionalText(value, 500);
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Enter a valid LinkedIn URL');
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'linkedin.com' && !url.hostname.endsWith('.linkedin.com'))
  ) {
    throw new Error('Enter a valid LinkedIn URL');
  }
  return url.toString();
}

export function fetchContactProfile(sql, userId, address) {
  return sql`
    SELECT c.name, i.company, i.role, i.linkedin_url, i.notes
    FROM (SELECT ${address}::text AS address) requested
    LEFT JOIN contacts c
      ON c.user_id = ${userId} AND c.address = requested.address
    LEFT JOIN contact_insights i
      ON i.user_id = ${userId} AND i.address = requested.address
  `;
}

export function fetchContactHistory(sql, userId, address, limit, before) {
  return sql`
    SELECT m.id, m.from_name, m.from_address, m.recipients, m.subject, m.snippet,
           m.sent_at, m.is_sent, m.is_unread, m.is_starred, m.is_archived,
           m.scheduled_for, m.follow_up_at,
           (m.body_html_url IS NOT NULL) AS has_html,
           EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments
    FROM messages m
    WHERE m.user_id = ${userId}
      AND NOT m.is_deleted
      AND m.screening_status = 'allowed'
      AND (
        (NOT m.is_sent AND lower(btrim(m.from_address)) = ${address})
        OR (
          m.is_sent AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              coalesce(m.recipients->'to', '[]'::jsonb)
              || coalesce(m.recipients->'cc', '[]'::jsonb)
              || coalesce(m.recipients->'bcc', '[]'::jsonb)
            ) recipient
            WHERE lower(btrim(
              CASE WHEN jsonb_typeof(recipient) = 'string' THEN recipient #>> '{}'
                   ELSE recipient->>'address' END
            )) = ${address}
          )
        )
      )
      AND (
        ${before?.sentAt ?? null}::timestamptz IS NULL
        OR (m.sent_at, m.id) < (${before?.sentAt ?? null}::timestamptz, ${before?.id ?? null}::uuid)
      )
    ORDER BY m.sent_at DESC, m.id DESC
    LIMIT ${limit + 1}
  `;
}

export async function getContactInsights(sql, userId, url) {
  const address = normalizeContactAddress(url.searchParams.get('address'));
  if (!address) {
    return noStore(Response.json({ error: 'A valid email address is required' }, { status: 400 }));
  }

  const requestedLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  /** @type {{ sentAt: string, id: string } | null} */
  let before = null;
  try {
    const decoded = decodeCursor(
      url.searchParams.get('before'),
      (value) =>
        Array.isArray(value) && value.length === 2 && validTimestamp(value[0]) && validId(value[1]),
    );
    if (decoded) before = { sentAt: decoded[0], id: decoded[1] };
  } catch {
    return noStore(Response.json({ error: 'Invalid history cursor' }, { status: 400 }));
  }

  const [profileRows, historyRows] = await Promise.all([
    fetchContactProfile(sql, userId, address),
    fetchContactHistory(sql, userId, address, limit, before),
  ]);
  const profile = profileRows[0] ?? {};
  const history = historyRows.slice(0, limit);
  const last = history.at(-1);

  return noStore(
    Response.json({
      contact: {
        address,
        name: profile.name ?? null,
        company: profile.company ?? null,
        role: profile.role ?? null,
        linkedinUrl: profile.linkedin_url ?? null,
        notes: profile.notes ?? '',
      },
      history,
      nextCursor:
        historyRows.length > limit && last
          ? encodeCursor([timestamp(last.sent_at), last.id])
          : null,
    }),
  );
}

export async function patchContactInsights(sql, userId, body) {
  const address = normalizeContactAddress(body?.address);
  if (!address) {
    return noStore(Response.json({ error: 'A valid email address is required' }, { status: 400 }));
  }

  let company;
  let role;
  let linkedin;
  let notes;
  try {
    company = optionalText(body.company, 200);
    role = optionalText(body.role, 200);
    linkedin = linkedinUrl(body.linkedinUrl);
    notes = notesText(body.notes);
  } catch (error) {
    return noStore(Response.json({ error: /** @type {Error} */ (error).message }, { status: 400 }));
  }

  const rows = await sql`
    INSERT INTO contact_insights (user_id, address, company, role, linkedin_url, notes)
    VALUES (${userId}, ${address}, ${company}, ${role}, ${linkedin}, ${notes})
    ON CONFLICT (user_id, address) DO UPDATE SET
      company = EXCLUDED.company,
      role = EXCLUDED.role,
      linkedin_url = EXCLUDED.linkedin_url,
      notes = EXCLUDED.notes,
      updated_at = now()
    RETURNING company, role, linkedin_url, notes
  `;
  const saved = rows[0];
  return noStore(
    Response.json({
      contact: {
        address,
        company: saved.company ?? null,
        role: saved.role ?? null,
        linkedinUrl: saved.linkedin_url ?? null,
        notes: saved.notes ?? '',
      },
    }),
  );
}
