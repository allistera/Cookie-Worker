import { parseFollowUpAt } from './outbound.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {import('postgres').Sql} sql @param {string} userId @param {Request} request */
export async function handleFollowUp(sql, userId, request) {
  if (request.method !== 'PATCH')
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'PATCH' } },
    );
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const response = bodyErrorResponse(error);
    if (response) return response;
    throw error;
  }
  if (!body || !UUID_RE.test(body.messageId) || !Object.hasOwn(body, 'followUpAt')) {
    return Response.json({ error: 'messageId and followUpAt are required' }, { status: 400 });
  }
  const followUpAt = body.followUpAt === null ? null : parseFollowUpAt(body.followUpAt);
  if (body.followUpAt !== null && !followUpAt)
    return Response.json(
      { error: 'followUpAt must be an ISO timestamp at least a minute out' },
      { status: 400 },
    );
  const [message] = await sql`
    UPDATE messages m SET follow_up_at = ${followUpAt}::timestamptz
    WHERE m.id = ${body.messageId}::uuid AND m.user_id = ${userId} AND m.is_sent AND NOT m.is_deleted
      AND (${followUpAt}::timestamptz IS NULL OR NOT EXISTS (
        SELECT 1 FROM messages reply WHERE reply.user_id = m.user_id
          AND reply.thread_id = m.thread_id AND NOT reply.is_sent AND NOT reply.is_deleted AND reply.sent_at > m.sent_at
          AND reply.screening_status = 'allowed'
      ))
    RETURNING m.id, m.follow_up_at AS "followUpAt"
  `;
  if (message) return Response.json({ message });
  const [owned] =
    await sql`SELECT 1 FROM messages WHERE id = ${body.messageId}::uuid AND user_id = ${userId} AND is_sent AND NOT is_deleted`;
  return Response.json(
    { error: owned ? 'This message already has a reply' : 'Sent message not found' },
    { status: owned ? 409 : 404 },
  );
}
