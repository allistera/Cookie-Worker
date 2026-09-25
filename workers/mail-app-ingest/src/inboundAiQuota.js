import { allowRequest } from '../../../shared/rate-limit.js';

// Shared by classification (one slot per enrichment run, however many
// transient retries it makes) and reply generation across new-mail and
// recovery jobs; ordinary delivery never spends this budget.
export const INBOUND_AI_LIMIT = { limit: 200, windowMs: 24 * 60 * 60 * 1000 };

export class InboundAiQuotaExceeded extends Error {
  constructor() {
    super('Inbound AI budget exhausted');
  }
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function claimInboundAiRequest(sql, userId) {
  if (!userId || !(await allowRequest(sql, userId, 'inbound-ai', INBOUND_AI_LIMIT))) {
    throw new InboundAiQuotaExceeded();
  }
}
