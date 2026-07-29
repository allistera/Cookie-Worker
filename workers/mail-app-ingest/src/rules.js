/**
 * Deterministic tag rules: subject/body/from/to conditions a user defines in
 * Cookie-Web, matched against every inbound message. Unlike AI auto-tagging,
 * matching is exact string comparison, so it runs synchronously inside the
 * same transaction that stores the message — no async waitUntil, no
 * confidence threshold, no recovery cron.
 *
 * @param {any} record
 * @param {string} field
 * @returns {string}
 */
export function fieldValue(record, field) {
  switch (field) {
    case 'subject':
      return record.subject || '';
    case 'body':
      return record.bodyText || '';
    case 'from':
      return [record.fromName, record.fromAddress].filter(Boolean).join(' ');
    case 'to':
      return (record.recipients?.to || [])
        .map((recipient) => [recipient.name, recipient.address].filter(Boolean).join(' '))
        .join(', ');
    default:
      return '';
  }
}

/**
 * @param {any} record
 * @param {{field: string, operator: string, value: string}} condition
 * @returns {boolean}
 */
export function matchesCondition(record, condition) {
  const haystack = fieldValue(record, condition.field).toLowerCase();
  const needle = String(condition.value || '').toLowerCase();
  if (!needle) return false;
  switch (condition.operator) {
    case 'contains':
      return haystack.includes(needle);
    case 'equals':
      return haystack === needle;
    case 'starts_with':
      return haystack.startsWith(needle);
    case 'ends_with':
      return haystack.endsWith(needle);
    default:
      return false;
  }
}

/**
 * @param {any} record
 * @param {{matchType: string, conditions: {field: string, operator: string, value: string}[]}} rule
 * @returns {boolean}
 */
export function matchesRule(record, rule) {
  if (!rule.conditions.length) return false;
  return rule.matchType === 'any'
    ? rule.conditions.some((condition) => matchesCondition(record, condition))
    : rule.conditions.every((condition) => matchesCondition(record, condition));
}

/**
 * Fetches the user's enabled rules and applies every match as a
 * source = 'rule' label, tagged with the rule that applied it. Runs inside
 * the caller's storage transaction so a rule tag either lands with the
 * message or not at all.
 *
 * @param {import('postgres').TransactionSql} tx
 * @param {string} userId
 * @param {string} messageUuid
 * @param {any} record
 * @returns {Promise<number>} number of rules that matched and applied
 */
export async function applyLabelRules(tx, userId, messageUuid, record) {
  const rows = await tx`
    SELECT r.id AS rule_id, r.label_id, r.match_type,
           c.field, c.operator, c.value
    FROM label_rules r
    JOIN label_rule_conditions c ON c.rule_id = r.id
    WHERE r.user_id = ${userId} AND r.enabled
    ORDER BY r.id, c.position
  `;

  /** @type {Map<string, {id: string, labelId: string, matchType: string, conditions: {field: string, operator: string, value: string}[]}>} */
  const rules = new Map();
  for (const row of rows) {
    let rule = rules.get(row.rule_id);
    if (!rule) {
      rule = { id: row.rule_id, labelId: row.label_id, matchType: row.match_type, conditions: [] };
      rules.set(row.rule_id, rule);
    }
    rule.conditions.push({ field: row.field, operator: row.operator, value: row.value });
  }

  let applied = 0;
  for (const rule of rules.values()) {
    if (!matchesRule(record, rule)) continue;
    await tx`
      INSERT INTO message_labels (message_id, label_id, source, rule_id)
      VALUES (${messageUuid}, ${rule.labelId}, 'rule', ${rule.id})
      ON CONFLICT (message_id, label_id) DO NOTHING
    `;
    applied += 1;
  }
  return applied;
}
