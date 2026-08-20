// Ported from Cookie-Web's api/_lib/label-rules.js, previously reached via
// api/labels.js?resource=rules purely to stay under Vercel Hobby's
// function-count limit. Now a clean path: GET/POST/PATCH/DELETE /labels/rules.
// Rule matching itself still runs in Cookie-Worker's mail-app-ingest at
// inbound storage time — this only manages rule definitions.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ['subject', 'body', 'from', 'to'];
const OPERATORS = ['contains', 'equals', 'starts_with', 'ends_with'];
const MATCH_TYPES = ['all', 'any'];
const ACTIONS = ['apply_label', 'mark_done'];
const MAX_NAME = 100;
const MAX_VALUE = 200;
const MAX_CONDITIONS = 10;

/** @param {any} input */
function normalizeConditions(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_CONDITIONS) return null;
  const conditions = [];
  for (const raw of input) {
    const field = String(raw?.field ?? '');
    const operator = String(raw?.operator ?? '');
    const value = String(raw?.value ?? '').trim();
    if (
      !FIELDS.includes(field) ||
      !OPERATORS.includes(operator) ||
      !value ||
      value.length > MAX_VALUE
    ) {
      return null;
    }
    conditions.push({ field, operator, value });
  }
  return conditions;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function listRules(sql, userId) {
  const rows = await sql`
    SELECT r.id, r.name, r.label_id, r.action, r.match_type, r.enabled, r.created_at,
           c.id AS condition_id, c.field, c.operator, c.value, c.position
    FROM label_rules r
    LEFT JOIN label_rule_conditions c ON c.rule_id = r.id
    WHERE r.user_id = ${userId}
    ORDER BY r.created_at, c.position
  `;
  /** @type {any[]} */
  const rules = [];
  const byId = new Map();
  for (const row of rows) {
    let rule = byId.get(row.id);
    if (!rule) {
      rule = {
        id: row.id,
        name: row.name,
        label_id: row.label_id,
        action: row.action,
        match_type: row.match_type,
        enabled: row.enabled,
        conditions: [],
      };
      byId.set(row.id, rule);
      rules.push(rule);
    }
    if (row.condition_id) {
      rule.conditions.push({
        id: row.condition_id,
        field: row.field,
        operator: row.operator,
        value: row.value,
      });
    }
  }
  return Response.json({ rules });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function createRule(sql, userId, body) {
  const name = String(body?.name ?? '').trim() || null;
  const action = ACTIONS.includes(body?.action) ? body.action : 'apply_label';
  const labelId = UUID_RE.test(body?.label_id) ? String(body.label_id) : null;
  const matchType = MATCH_TYPES.includes(body?.match_type) ? body.match_type : 'all';
  const enabled = body?.enabled === true || body?.enabled === false ? body.enabled : true;
  const conditions = normalizeConditions(body?.conditions);

  if (
    !conditions ||
    (name && name.length > MAX_NAME) ||
    (action === 'apply_label' && !labelId) ||
    (action === 'mark_done' && labelId)
  ) {
    return Response.json(
      {
        error:
          'A valid action (with label_id for apply_label) and 1-10 valid conditions are required',
      },
      { status: 400 },
    );
  }

  const positionedConditions = conditions.map((condition, position) => ({
    ...condition,
    position,
  }));
  let rule;
  try {
    rule = await sql.begin(async (tx) => {
      let inserted;
      if (action === 'apply_label') {
        [inserted] = await tx`
          INSERT INTO label_rules (user_id, label_id, name, action, match_type, enabled)
          SELECT ${userId}, ${labelId}, ${name}, ${action}, ${matchType}, ${enabled}
          WHERE EXISTS (
            SELECT 1 FROM labels l WHERE l.id = ${labelId} AND l.user_id = ${userId} AND l.kind = 'user'
          )
          RETURNING id, name, label_id, action, match_type, enabled
        `;
        if (!inserted) return null;
      } else {
        [inserted] = await tx`
          INSERT INTO label_rules (user_id, label_id, name, action, match_type, enabled)
          VALUES (${userId}, NULL, ${name}, ${action}, ${matchType}, ${enabled})
          RETURNING id, name, label_id, action, match_type, enabled
        `;
      }

      await tx`
        INSERT INTO label_rule_conditions (rule_id, field, operator, value, position)
        SELECT ${inserted.id}, row.field, row.operator, row.value, row.position
        FROM json_to_recordset(${positionedConditions}::json)
          AS row(field text, operator text, value text, position int)
      `;
      return inserted;
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'create_rule_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return Response.json({ error: 'Failed to create rule' }, { status: 500 });
  }
  if (!rule) {
    return Response.json({ error: 'Label not found' }, { status: 404 });
  }

  return Response.json({ rule: { ...rule, conditions: positionedConditions } }, { status: 201 });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function updateRule(sql, userId, body) {
  const id = UUID_RE.test(body?.id) ? String(body.id) : null;
  const hasName = Object.hasOwn(body ?? {}, 'name');
  const hasAction = Object.hasOwn(body ?? {}, 'action');
  const hasLabelId = Object.hasOwn(body ?? {}, 'label_id');
  const hasMatchType = Object.hasOwn(body ?? {}, 'match_type');
  const hasEnabled = Object.hasOwn(body ?? {}, 'enabled');
  const hasConditions = Object.hasOwn(body ?? {}, 'conditions');

  const name = String(body?.name ?? '').trim() || null;
  const labelId = UUID_RE.test(body?.label_id) ? String(body.label_id) : null;
  const conditions = hasConditions ? normalizeConditions(body?.conditions) : undefined;

  if (
    !id ||
    (!hasName && !hasAction && !hasLabelId && !hasMatchType && !hasEnabled && !hasConditions) ||
    (hasAction && !ACTIONS.includes(body.action)) ||
    (hasLabelId && !labelId) ||
    (hasName && name && name.length > MAX_NAME) ||
    (hasMatchType && !MATCH_TYPES.includes(body.match_type)) ||
    (hasEnabled && body.enabled !== true && body.enabled !== false) ||
    (hasConditions && !conditions)
  ) {
    return Response.json({ error: 'id and a valid rule update are required' }, { status: 400 });
  }

  const [existing] = await sql`
    SELECT r.name, r.label_id, r.action, r.match_type, r.enabled
    FROM label_rules r
    WHERE r.id = ${id} AND r.user_id = ${userId}
  `;
  if (!existing) {
    return Response.json({ error: 'Rule not found' }, { status: 404 });
  }

  const resultAction = hasAction ? body.action : existing.action;
  // mark_done clears any label, even one already on the rule, since a rule
  // can only carry a label meaningful to its own action.
  const resultLabelId =
    resultAction === 'mark_done' ? null : hasLabelId ? labelId : existing.label_id;

  if (
    (resultAction === 'apply_label' && !resultLabelId) ||
    (resultAction === 'mark_done' && hasLabelId)
  ) {
    return Response.json(
      { error: 'apply_label requires label_id; mark_done cannot set one' },
      { status: 400 },
    );
  }

  if (hasLabelId && resultAction === 'apply_label') {
    const [label] = await sql`
      SELECT 1 FROM labels l
      WHERE l.id = ${labelId} AND l.user_id = ${userId} AND l.kind = 'user'
    `;
    if (!label) {
      return Response.json({ error: 'Label not found' }, { status: 404 });
    }
  }

  const positionedConditions = hasConditions
    ? /** @type {any[]} */ (conditions).map((condition, position) => ({ ...condition, position }))
    : null;

  const [rule] = await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE label_rules r
      SET name = ${hasName ? name : existing.name},
          label_id = ${resultLabelId},
          action = ${resultAction},
          match_type = ${hasMatchType ? body.match_type : existing.match_type},
          enabled = ${hasEnabled ? body.enabled : existing.enabled},
          updated_at = now()
      WHERE r.id = ${id} AND r.user_id = ${userId}
      RETURNING r.id, r.name, r.label_id, r.action, r.match_type, r.enabled
    `;
    if (positionedConditions) {
      await tx`DELETE FROM label_rule_conditions WHERE rule_id = ${id}`;
      await tx`
        INSERT INTO label_rule_conditions (rule_id, field, operator, value, position)
        SELECT ${id}, row.field, row.operator, row.value, row.position
        FROM json_to_recordset(${positionedConditions}::json)
          AS row(field text, operator text, value text, position int)
      `;
    }
    return rows;
  });

  const rows =
    positionedConditions ??
    (await sql`
      SELECT field, operator, value, position FROM label_rule_conditions
      WHERE rule_id = ${id} ORDER BY position
    `);
  return Response.json({ rule: { ...rule, conditions: rows } });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function deleteRule(sql, userId, body) {
  const id = UUID_RE.test(body?.id) ? String(body.id) : null;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  const rows = await sql`
    DELETE FROM label_rules r
    WHERE r.id = ${id} AND r.user_id = ${userId}
    RETURNING r.id
  `;
  if (rows.length === 0) {
    return Response.json({ error: 'Rule not found' }, { status: 404 });
  }
  return Response.json({ ok: true });
}
