import { afterEach, expect, test, vi } from 'vitest';
import { handleRuleDraft } from '../src/ruleDraft.js';

const label = { id: '11111111-1111-4111-8111-111111111111', name: 'Finance' };
const draft = {
  name: 'Bills',
  kind: 'conditions',
  prompt: null,
  action: 'apply_label',
  label_id: label.id,
  match_type: 'all',
  conditions: [{ field: 'from', operator: 'equals', value: 'billing@example.com' }],
};
const env = { OPENAI_API_KEY: 'test-key' };

/** @param {any} [output] */
function setup(output = { draft, error: null }) {
  const sql = vi.fn().mockResolvedValue([label]);
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ output_text: JSON.stringify(output) }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return { sql, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

test('returns an unsaved validated draft using only owned user labels', async () => {
  const { sql, fetchMock } = setup();
  const response = await handleRuleDraft(
    /** @type {any} */ (sql),
    'owner',
    { instruction: 'Tag bills Finance' },
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ draft });
  expect(sql).toHaveBeenCalledOnce();
  expect(sql.mock.calls[0][0].join('?')).toContain("user_id = ? AND kind = 'user'");
  expect(sql.mock.calls[0][1]).toBe('owner');
  const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(JSON.parse(payload.input[1].content)).toEqual({
    instruction: 'Tag bills Finance',
    labels: [label],
  });
  expect(payload.text.format.strict).toBe(true);
});

test.each([null, {}, { instruction: 4 }, { instruction: ' ' }, { instruction: 'x'.repeat(1001) }])(
  'rejects invalid input without external calls: %j',
  async (body) => {
    const { sql, fetchMock } = setup();
    const response = await handleRuleDraft(/** @type {any} */ (sql), 'owner', body, env);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test('supports semantic matching and mark done without a label', async () => {
  const semantic = {
    ...draft,
    kind: 'ai',
    prompt: 'Unsolicited sales pitches',
    conditions: [],
    action: 'mark_done',
    label_id: null,
  };
  const { sql } = setup({ draft: semantic, error: null });
  const response = await handleRuleDraft(
    /** @type {any} */ (sql),
    'owner',
    { instruction: 'Archive sales pitches' },
    env,
  );
  expect(await response.json()).toMatchObject({ draft: semantic });
});

test('allows an unresolved tag for the user to select during review', async () => {
  const { sql } = setup({ draft: { ...draft, label_id: null }, error: null });
  const response = await handleRuleDraft(
    /** @type {any} */ (sql),
    'owner',
    { instruction: 'Tag bills' },
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ draft: { label_id: null } });
});

test.each([
  { label_id: '22222222-2222-4222-8222-222222222222' },
  { conditions: [] },
  { conditions: Array(11).fill(draft.conditions[0]) },
  { conditions: [{ field: 'subject', operator: 'regex', value: '.*' }] },
  { conditions: [{ field: 'from', operator: 'contains', value: '' }] },
  { conditions: [{ field: 'from', operator: 'contains', value: 'x'.repeat(201) }] },
  { kind: 'ai', prompt: 'x', conditions: draft.conditions },
  { prompt: 'mixed matchers' },
  { name: 'x'.repeat(101) },
  { action: 'delete' },
  { action: 'mark_done' },
  { match_type: 'none' },
])('rejects invalid or foreign-label model output: %j', async (changes) => {
  const { sql } = setup({ draft: { ...draft, ...changes }, error: null });
  const response = await handleRuleDraft(
    /** @type {any} */ (sql),
    'owner',
    { instruction: 'Filter mail' },
    env,
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'AI rule generation failed. Please try again.' });
});

test('explains unsupported requests without saving a rule', async () => {
  const { sql } = setup({ draft: null, error: 'Rules cannot forward mail.' });
  const response = await handleRuleDraft(
    /** @type {any} */ (sql),
    'owner',
    { instruction: 'Forward everything' },
    env,
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: 'Rules cannot forward mail.' });
  expect(sql).toHaveBeenCalledOnce();
});

test.each(['timeout', 'invalid json', 'refusal', 'upstream'])(
  'handles %s without exposing upstream details',
  async (failure) => {
    const { sql, fetchMock } = setup();
    if (failure === 'timeout') fetchMock.mockRejectedValue(new Error('secret upstream details'));
    else
      fetchMock.mockResolvedValue({
        ok: failure !== 'upstream',
        json: async () => ({ output_text: failure === 'invalid json' ? 'bad json' : '' }),
      });
    const response = await handleRuleDraft(
      /** @type {any} */ (sql),
      'owner',
      { instruction: 'Filter mail' },
      env,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'AI rule generation failed. Please try again.',
    });
  },
);
