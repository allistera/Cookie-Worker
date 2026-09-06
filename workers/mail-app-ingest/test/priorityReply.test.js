import { claimInboundAiRequest, InboundAiQuotaExceeded } from '../src/inboundAiQuota.js';
vi.mock('../src/inboundAiQuota.js', async (importOriginal) => ({
  ...(await importOriginal()),
  claimInboundAiRequest: vi.fn(async () => undefined),
}));
import { afterEach, describe, expect, test, vi } from 'vitest';
import { draftPriorityReply, generatePriorityReply } from '../src/priorityReply.js';

const MESSAGE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const candidate = {
  id: MESSAGE,
  user_id: USER,
  from_address: 'alice@example.com',
  from_name: 'Alice',
  subject: 'Review the plan',
  body_text: 'Could you review the attached plan?',
  reply_draft_attempts: 1,
};

// External database boundary. Assertions cover the saved payload and the
// ownership/lease predicates; the migration is also exercised on Postgres.
function database({ claimed = true, eligible = true, saved = true } = {}) {
  const calls = [];
  const sql = Object.assign(
    async (strings, ...values) => {
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('RETURNING m.id')) return claimed ? [candidate] : [];
      if (text.includes('SELECT m.id')) return eligible ? [candidate] : [];
      if (text.includes('INSERT INTO drafts')) return saved ? [{ id: 'draft-1' }] : [];
      return [];
    },
    { begin: async (fn) => fn(sql), calls },
  );
  return /** @type {any} */ (sql);
}

afterEach(() => vi.unstubAllGlobals());

describe('priority reply drafts', () => {
  test('saves a reply to the original sender, using the existing subject and ownership', async () => {
    const sql = database();
    const generate = vi.fn(
      async () => 'Thanks for sending the plan. Which section needs attention first?',
    );
    expect(await draftPriorityReply(sql, MESSAGE, 'test-key', 'test-model', generate)).toBe(
      'completed',
    );
    const insert = sql.calls.find((call) => call.text.includes('INSERT INTO drafts'));
    expect(insert.values).toContain(USER);
    expect(insert.values).toContain(MESSAGE);
    expect(insert.values).toContain('alice@example.com');
    expect(insert.values).toContain('Re: Review the plan');
    expect(insert.values).toContain(
      'Thanks for sending the plan. Which section needs attention first?',
    );
    expect(insert.text).toContain('is_ai_generated');
    expect(sql.calls.some((call) => call.values.includes('completed'))).toBe(true);
  });

  test('does no AI work when another run already claimed or completed the draft', async () => {
    const sql = database({ claimed: false });
    const generate = vi.fn();
    expect(await draftPriorityReply(sql, MESSAGE, 'test-key', 'test-model', generate)).toBe(
      'unchanged',
    );
    expect(generate).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain("ai.priority = 'high'");
    expect(sql.calls[0].text).toContain("ai.spam_verdict = 'inbox'");
    expect(sql.calls[0].text).toContain('reply_draft_attempts < 3');
  });

  test('checks current message and thread eligibility in the same statement that saves the draft', async () => {
    const sql = database();
    await draftPriorityReply(sql, MESSAGE, 'test-key', 'test-model', async () => 'Reply');
    const insert = sql.calls.find((call) => call.text.includes('INSERT INTO drafts'));
    for (const condition of [
      'NOT m.is_sent',
      'NOT m.is_deleted',
      'NOT m.is_archived',
      "ai.status = 'completed'",
      "ai.priority = 'high'",
      "ai.spam_verdict = 'inbox'",
      'newer.user_id = m.user_id',
      'newer.thread_id = m.thread_id',
      'd.user_id = m.user_id',
      'target.thread_id = m.thread_id',
      's.user_id = m.user_id',
      "s.status IN ('pending', 'sending', 'sent')",
    ])
      expect(insert.text).toContain(condition);
    expect(insert.values).toContain(MESSAGE);
    expect(insert.values).toContain(USER);
    expect(insert.text).toContain('reply_draft_attempts');
  });

  test('stands down when a manual draft, sent reply, or changed classification wins the race', async () => {
    const sql = database({ eligible: false });
    expect(
      await draftPriorityReply(sql, MESSAGE, 'test-key', 'test-model', async () => 'Reply'),
    ).toBe('skipped');
    expect(sql.calls.some((call) => call.text.includes('INSERT INTO drafts'))).toBe(false);
    const check = sql.calls.find((call) => call.text.includes('SELECT m.id'));
    expect(check.text).toContain('d.user_id = m.user_id');
    expect(check.text).toContain('newer.user_id = m.user_id');
    expect(check.text).toContain('scheduled_sends');
    expect(sql.calls.some((call) => call.values.includes('skipped'))).toBe(true);
  });

  test('does not fabricate another draft when the mailbox has reached its saved-draft cap', async () => {
    const sql = database({ saved: false });
    expect(
      await draftPriorityReply(sql, MESSAGE, 'test-key', 'test-model', async () => 'Reply'),
    ).toBe('skipped');
    expect(sql.calls.find((call) => call.text.includes('INSERT INTO drafts')).text).toContain(
      '< 200',
    );
  });

  test('leaves classification intact and records a retryable failure without saving provider details', async () => {
    const sql = database();
    expect(
      await draftPriorityReply(sql, MESSAGE, 'test-key', 'test-model', async () => {
        throw new Error('sensitive provider payload');
      }),
    ).toBe('failed');
    const update = sql.calls.at(-1);
    expect(update.text).toContain('reply_draft_status');
    expect(update.values).toContain('failed');
    expect(JSON.stringify(sql.calls)).not.toContain('sensitive provider payload');
    expect(update.text).not.toContain('SET status =');
  });

  test('never stores an empty generated reply', async () => {
    const sql = database();
    expect(await draftPriorityReply(sql, MESSAGE, 'test-key', 'test-model', async () => ' ')).toBe(
      'failed',
    );
    expect(sql.calls.some((call) => call.text.includes('INSERT INTO drafts'))).toBe(false);
  });

  test('generates plain text from bounded, untrusted email context without retaining the response', async () => {
    const requests = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ output_text: JSON.stringify({ text: 'Thanks for the details.' }) });
    });
    expect(
      await generatePriorityReply(
        { ...candidate, body_text: 'x'.repeat(20000) },
        'test-key',
        'test-model',
      ),
    ).toBe('Thanks for the details.');
    expect(requests[0]).toMatchObject({
      store: false,
      model: 'test-model',
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(requests[0].input[0].content).toContain('untrusted data');
    expect(requests[0].input[0].content).toContain('never invent');
    expect(JSON.parse(requests[0].input[1].content).body).toHaveLength(12000);
  });
});

test('defers reply generation and returns the unused attempt when the owner budget is exhausted', async () => {
  const sql = database();
  const generate = vi.fn();
  vi.mocked(claimInboundAiRequest).mockRejectedValueOnce(new InboundAiQuotaExceeded());
  expect(await draftPriorityReply(sql, MESSAGE, 'key', 'model', generate)).toBe('deferred');
  expect(claimInboundAiRequest).toHaveBeenCalledWith(sql, USER);
  expect(generate).not.toHaveBeenCalled();
  const release = sql.calls.find((call) =>
    call.text.includes('reply_draft_attempts = reply_draft_attempts - 1'),
  );
  expect(release.text).toContain("reply_draft_status = 'pending'");
  expect(release.values).toEqual([MESSAGE, candidate.reply_draft_attempts]);
  expect(sql.calls.some((call) => call.text.includes('INSERT INTO drafts'))).toBe(false);
});
