// A small transactional model for behavioral race/retry tests. Queries outside
// the supported responder contract throw instead of silently returning [].
export const OWNER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const MESSAGE = '33333333-3333-4333-8333-333333333333';
export const DELIVERY = '44444444-4444-4444-8444-444444444444';
export const FROM = 'Cookie <mail@example.com>';
export const SETTINGS = {
  revision: 1,
  enabled: true,
  startDate: '2026-10-25',
  endDate: '2026-11-10',
  timeZone: 'Europe/London',
  subject: 'Away',
  text: 'I will reply when I return.',
  activatedAt: '2026-10-24T10:00:00.000Z',
};

export function autoReplyDatabase({ queued = true } = {}) {
  const state = /** @type {any} */ ({
    now: new Date('2026-10-25T12:00:00Z'),
    users: new Map([
      [
        OWNER,
        {
          id: OWNER,
          email: 'owner@example.com',
          auth0_sub: 'auth0|owner',
          settings: { ...SETTINGS },
          theme: 'dark',
        },
      ],
      [
        OTHER,
        {
          id: OTHER,
          email: 'other@example.com',
          auth0_sub: 'auth0|other',
          settings: { ...SETTINGS, enabled: false },
          theme: 'light',
        },
      ],
    ]),
    messages: new Map([
      [
        MESSAGE,
        {
          id: MESSAGE,
          user_id: OWNER,
          message_id: '<original@example.com>',
          created_at: '2026-10-25T11:00:00Z',
          out_of_office_revision: 1,
          from_address: 'sender@example.com',
          envelope_from: 'sender@example.com',
          envelope_to: 'mail@example.com',
          recipients: { to: [{ address: 'mail@example.com' }], cc: [] },
          headers: [],
          ai_status: 'completed',
          spam_verdict: 'inbox',
          is_sent: false,
          is_deleted: false,
          auto_reply_suppressed: false,
        },
      ],
    ]),
    deliveries: new Map(),
    senders: new Map(),
    quota: 0,
    quotaAvailable: true,
    failSentCommit: false,
    queries: /** @type {string[]} */ ([]),
  });
  function newDelivery(id = DELIVERY, messageId = MESSAGE) {
    return {
      id,
      user_id: OWNER,
      message_id: messageId,
      settings_revision: 1,
      recipient: 'sender@example.com',
      payload: {
        from: FROM,
        to: ['sender@example.com'],
        subject: SETTINGS.subject,
        text: SETTINGS.text,
        headers: {
          'Auto-Submitted': 'auto-replied',
          'X-Auto-Response-Suppress': 'All',
          Precedence: 'bulk',
        },
      },
      status: 'pending',
      attempts: 0,
      quota_reserved: false,
      first_attempt_at: null,
      retry_until: null,
      next_attempt_at: '2026-10-25T12:00:00.000Z',
      claimed_at: null,
      claim_token: null,
      resolved_at: null,
    };
  }
  if (queued) state.deliveries.set(DELIVERY, newDelivery());
  const copy = (value) => structuredClone(value);
  const find = (id, owner) => {
    const row = state.deliveries.get(id);
    return row?.user_id === owner ? row : null;
  };
  /** @type {any} */
  const sql = async (parts, ...v) => {
    const text = parts.join('?').replace(/\s+/g, ' ').trim();
    state.queries.push(text);
    if (text.startsWith('SELECT pg_advisory_xact_lock')) return [];
    if (text === 'SELECT clock_timestamp() AS now') return [{ now: state.now }];
    if (text.startsWith('SELECT') && text.includes('FROM users WHERE id')) {
      const user = state.users.get(v[0]);
      return user ? [copy(user)] : [];
    }
    if (text.startsWith('UPDATE users')) {
      const owner = state.users.get(v[1]);
      if (owner) owner.settings = copy(v[0]);
      return [];
    }
    if (text.includes('FROM messages m JOIN users u')) {
      return [...state.messages.values()]
        .filter((m) => {
          const user = state.users.get(m.user_id);
          return (
            user?.settings.enabled &&
            user.settings.revision === m.out_of_office_revision &&
            m.ai_status === 'completed' &&
            m.spam_verdict === 'inbox' &&
            !m.is_sent &&
            ![...state.deliveries.values()].some(
              (d) => d.message_id === m.id && d.user_id === m.user_id,
            )
          );
        })
        .slice(0, v[0])
        .map((m) => ({
          ...copy(m),
          owner_email: state.users.get(m.user_id)?.email,
          settings: copy(state.users.get(m.user_id)?.settings),
          clock: state.now,
        }));
    }
    if (text.includes('FROM messages m JOIN message_ai')) {
      const m = state.messages.get(v[0]);
      return m?.user_id === v[1] ? [copy(m)] : [];
    }
    if (text.startsWith('INSERT INTO out_of_office_deliveries')) {
      if (
        ![...state.deliveries.values()].some((d) => d.message_id === v[1] && d.user_id === v[0])
      ) {
        const row = {
          ...newDelivery(crypto.randomUUID(), v[1]),
          user_id: v[0],
          settings_revision: v[2],
          recipient: v[3],
          payload: copy(v[4]),
          status: v[5],
          reason: v[6],
        };
        state.deliveries.set(row.id, row);
      }
      return [];
    }
    if (text.startsWith('SELECT id, user_id FROM out_of_office_deliveries')) {
      return [...state.deliveries.values()]
        .filter((row) => row.status === 'pending')
        .slice(0, v[0])
        .map(copy);
    }
    if (text.startsWith("SELECT * FROM out_of_office_deliveries WHERE status = 'sent'")) return [];
    if (text.startsWith('SELECT * FROM out_of_office_deliveries')) {
      const row = find(v[0], v[1]);
      return row ? [copy(row)] : [];
    }
    if (text.startsWith('SELECT id, recipient'))
      return [...state.deliveries.values()]
        .filter(
          (d) => d.user_id === v[0] && ['uncertain', 'failed'].includes(d.status) && !d.resolved_at,
        )
        .map(copy);
    if (text.startsWith('SELECT s.*, d.status AS delivery_status')) {
      const row = state.senders.get(`${v[0]}/${v[1]}`);
      return row
        ? [{ ...copy(row), delivery_status: state.deliveries.get(row.delivery_id)?.status }]
        : [];
    }
    if (text.startsWith('WITH claimed AS')) {
      if (state.quotaAvailable) state.quota++;
      return [{ authorized: true, quota_claimed: state.quotaAvailable }];
    }
    if (text.startsWith('INSERT INTO out_of_office_senders')) {
      const key = `${v[0]}/${v[1]}`;
      if (state.senders.get(key)?.delivery_id !== v[2])
        state.senders.set(key, {
          user_id: v[0],
          sender: v[1],
          delivery_id: v[2],
          next_allowed_at: new Date(new Date(v[3]).getTime() + 4 * 86400_000).toISOString(),
          blocked: false,
        });
      return [];
    }
    if (text.startsWith('UPDATE out_of_office_senders')) {
      const resolving = text.includes('blocked = false');
      const [owner, id] = resolving ? [v[1], v[2]] : v;
      const sender = [...state.senders.values()].find(
        (s) => s.user_id === owner && s.delivery_id === id,
      );
      if (sender) {
        if (text.includes('blocked = true')) sender.blocked = true;
        else {
          sender.blocked = false;
          sender.next_allowed_at = new Date(
            state.now.getTime() + (resolving && !v[0] ? 0 : 4 * 86400_000),
          ).toISOString();
        }
      }
      return [];
    }
    if (text.startsWith('UPDATE out_of_office_deliveries')) {
      const [id, owner] = v.slice(-2);
      const row = find(id, owner);
      if (!row) return [];
      if (text.includes("status = 'sending'")) {
        Object.assign(row, {
          status: 'sending',
          attempts: row.attempts + 1,
          quota_reserved: true,
          claimed_at: v[0],
          claim_token: v[1],
          first_attempt_at: row.first_attempt_at ?? v[2],
          retry_until:
            row.retry_until ?? new Date(new Date(v[3]).getTime() + 23 * 3600_000).toISOString(),
        });
      } else if (text.includes("status = 'sent'")) {
        if (state.failSentCommit) throw new Error('simulated commit failure');
        Object.assign(row, {
          status: 'sent',
          provider_id: v[0],
          sent_at: state.now,
          claimed_at: null,
          claim_token: null,
        });
      } else if (text.includes("status = 'pending'")) {
        Object.assign(row, {
          status: 'pending',
          next_attempt_at: v[0],
          claimed_at: null,
          claim_token: null,
        });
      } else if (text.includes('resolved_at = clock_timestamp()')) {
        if (!['uncertain', 'failed'].includes(row.status) || row.resolved_at) return [];
        Object.assign(row, { status: v[0], reason: v[1], resolved_at: state.now });
      } else
        Object.assign(row, { status: v[0], reason: v[1], claimed_at: null, claim_token: null });
      return [copy(row)];
    }
    throw new Error(`Unexpected SQL in responder test: ${text}`);
  };
  sql.json = (value) => value;
  let turn = Promise.resolve();
  sql.begin = async (callback) => {
    let release = () => {};
    const previous = turn;
    turn = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const before = {
      users: copy(state.users),
      deliveries: copy(state.deliveries),
      senders: copy(state.senders),
      quota: state.quota,
    };
    try {
      return await callback(sql);
    } catch (error) {
      Object.assign(state, before);
      throw error;
    } finally {
      release();
    }
  };
  return { sql, state, newDelivery };
}
