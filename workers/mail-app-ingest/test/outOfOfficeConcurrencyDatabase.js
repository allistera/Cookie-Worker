import { autoReplyDatabase } from '../../cookie-web-send/test/autoReplyDatabase.js';

// Focused concurrent adapter around the responder row model. Transactions do
// not share a global mutex: only the SQL-requested advisory/user/message locks
// conflict. User-row FOR UPDATE conflicts with ingest's FK KEY SHARE; plain
// SELECT does not. This models these regression boundaries, not all PostgreSQL.
export function outOfOfficeConcurrencyDatabase() {
  const model = autoReplyDatabase();
  const held = new Map();
  const waiting = new Map();
  const { state } = model;
  state.senderDecisions = new Map();
  state.concurrentQueries = [];
  for (const message of state.messages.values()) message.screening_status = 'allowed';

  function connect() {
    const execute = async (transaction, parts, ...values) => {
      const query = parts.join('?').replace(/\s+/g, ' ').trim();
      state.concurrentQueries.push({ query, values });
      state.now = new Date(Date.now());
      const acquire = async (key, mode = 'exclusive', nowait = false) => {
        if (!transaction) throw new Error('Lock outside transaction');
        for (;;) {
          const owners = held.get(key) ?? new Map();
          const conflict = [...owners].some(
            ([owner, heldMode]) =>
              owner !== transaction && (mode === 'exclusive' || heldMode === 'exclusive'),
          );
          if (!conflict) {
            owners.set(transaction, mode);
            held.set(key, owners);
            return;
          }
          if (nowait) throw Object.assign(new Error('row busy'), { code: '55P03' });
          await new Promise((resolve) => {
            waiting.set(key, [...(waiting.get(key) ?? []), resolve]);
          });
        }
      };
      if (query.startsWith('SELECT pg_advisory_xact_lock')) {
        if (query.includes("hashtext('cookie.out-of-office')")) {
          if (
            held.get(`ingest/${values[0]}`)?.has(transaction) ||
            held.get(`users/${values[0]}`)?.has(transaction)
          )
            throw new Error('Responder lock must precede ingest/user locks');
          await acquire(`responder/${values[0]}`);
        } else if (query.includes('hashtextextended')) await acquire(`ingest/${values[0]}`);
        else throw new Error('Unrecognized advisory lock');
        return [];
      }
      if (
        query.startsWith('SELECT') &&
        query.includes('FROM users WHERE id') &&
        query.includes('FOR UPDATE')
      )
        await acquire(`users/${values[0]}`);
      if (query.startsWith('UPDATE users')) await acquire(`users/${values[1]}`);
      if (query.startsWith("SELECT prefs -> 'senderScreening'")) {
        const owner = state.users.get(values[0]);
        return owner ? [{ enabled: owner.senderScreening === true }] : [];
      }
      if (query.startsWith('UPDATE users') && query.includes("'{senderScreening}'")) {
        state.users.get(values[1]).senderScreening = values[0];
        return [];
      }
      if (query.startsWith('SELECT from_address, screening_status FROM messages')) {
        await acquire(`messages/${values[0]}`);
        const message = state.messages.get(values[0]);
        return message?.user_id === values[1] && !message.is_sent && !message.is_deleted
          ? [{ ...message }]
          : [];
      }
      if (query.startsWith('INSERT INTO sender_decisions')) {
        state.senderDecisions.set(`${values[0]}/${values[1]}`, values[2]);
        return [];
      }
      if (query.startsWith('DELETE FROM sender_decisions')) {
        const key = `${values[0]}/${values[1]}`;
        if (state.senderDecisions.get(key) === values[2]) state.senderDecisions.delete(key);
        return [];
      }
      if (query.startsWith('SELECT decision FROM sender_decisions')) {
        const decision = state.senderDecisions.get(`${values[0]}/${values[1]}`);
        return decision ? [{ decision }] : [];
      }
      if (query.startsWith('SELECT address FROM sender_decisions')) {
        return state.senderDecisions.get(`${values[0]}/${values[1]}`) === 'blocked'
          ? [{ address: values[1] }]
          : [];
      }
      if (
        query.startsWith('DELETE FROM browser_notification_events') ||
        query.startsWith('DELETE FROM ntfy_notification_events')
      )
        return [];
      if (query.startsWith("UPDATE messages SET screening_status = 'allowed'")) {
        const message = state.messages.get(values[0]);
        if (message?.user_id === values[1]) {
          message.screening_status = 'allowed';
          message.search_indexed_at = null;
        }
        return [];
      }
      if (query.startsWith('UPDATE messages SET screening_status = ?')) {
        const changed = [];
        for (const message of state.messages.values()) {
          if (
            message.user_id !== values[1] ||
            message.from_address.trim().toLowerCase() !== values[2] ||
            message.is_sent ||
            message.is_deleted
          )
            continue;
          if (message.screening_status === 'allowed' && !(values[3] && message.id === values[4]))
            continue;
          await acquire(`messages/${message.id}`);
          Object.assign(message, {
            screening_status: values[0],
            auto_reply_suppressed: true,
            search_indexed_at: null,
          });
          changed.push({ id: message.id, thread_id: message.thread_id });
        }
        return changed;
      }
      if (query.startsWith('UPDATE threads SET ai_summary')) return [];
      if (query.includes('FROM messages m JOIN message_ai') && query.includes('FOR UPDATE')) {
        await acquire(`messages/${values[0]}`, 'exclusive', true);
        await acquire(`message_ai/${values[0]}`, 'exclusive', true);
      }
      if (query.startsWith('UPDATE messages SET auto_reply_suppressed = true')) {
        if (query.includes('lower(btrim(from_address))')) {
          for (const message of state.messages.values()) {
            if (
              message.user_id === values[0] &&
              message.from_address.trim().toLowerCase() === values[1] &&
              !message.is_sent
            ) {
              await acquire(`messages/${message.id}`);
              message.auto_reply_suppressed = true;
            }
          }
          return [];
        }
        await acquire(`messages/${values[0]}`);
        const message = state.messages.get(values[0]);
        if (message?.user_id === values[1]) message.auto_reply_suppressed = true;
        return [];
      }
      if (query.includes('FROM users') && query.includes('WHERE users.email')) {
        const ownerEmail = values.at(-1);
        const owner = [...state.users.values()].find((row) => row.email === ownerEmail);
        return owner
          ? [
              {
                id: owner.id,
                user_id: owner.id,
                is_duplicate: [...state.messages.values()].some(
                  (row) => row.user_id === owner.id && row.message_id === values[0],
                ),
              },
            ]
          : [];
      }
      if (query.includes('AS is_duplicate') && query.includes('AS thread_id')) {
        return [
          {
            is_duplicate: [...state.messages.values()].some(
              (row) => row.user_id === values[0] && row.message_id === values[1],
            ),
            thread_id: null,
          },
        ];
      }
      if (query.startsWith('INSERT INTO threads')) {
        // The new thread's user_id foreign key obtains KEY SHARE on users.
        await acquire(`users/${values[1]}`, 'shared');
        return [];
      }
      if (query.startsWith('INSERT INTO messages')) {
        await acquire(`users/${values[2]}`, 'shared');
        const settings = state.users.get(values[2]).settings;
        const decision = state.senderDecisions.get(
          `${values[2]}/${values[4].trim().toLowerCase()}`,
        );
        const screening =
          decision === 'blocked'
            ? 'blocked'
            : state.users.get(values[2]).senderScreening && decision !== 'accepted'
              ? 'held'
              : 'allowed';
        state.messages.set(values[0], {
          id: values[0],
          thread_id: values[1],
          user_id: values[2],
          from_address: values[4],
          recipients: values[5],
          message_id: values[11],
          headers: values[12],
          envelope_from: values[15],
          envelope_to: values[16],
          created_at: state.now.toISOString(),
          is_sent: false,
          is_deleted: false,
          out_of_office_revision: settings.enabled ? settings.revision : null,
          auto_reply_suppressed: screening !== 'allowed',
          screening_status: screening,
        });
        return [{ id: values[0] }];
      }
      if (query.startsWith('INSERT INTO message_ai')) {
        state.messages.get(values[0]).ai_status = 'pending';
        return [];
      }
      if (query.includes('FROM label_rules')) return [];
      return model.sql(parts, ...values);
    };
    const sql = /** @type {any} */ ((parts, ...values) => execute(null, parts, ...values));
    sql.json = model.sql.json;
    sql.end = async () => undefined;
    sql.begin = async (callback) => {
      const transaction = Symbol('transaction');
      const tx = (parts, ...values) => execute(transaction, parts, ...values);
      tx.json = model.sql.json;
      try {
        return await callback(tx);
      } finally {
        for (const [key, owners] of held) {
          if (!owners.delete(transaction)) continue;
          for (const resume of waiting.get(key) ?? []) resume();
          waiting.delete(key);
        }
      }
    };
    return sql;
  }
  return { ...model, connect };
}
