import { describe, expect, test } from 'vitest';
import { ensureSpamLabel } from '../spamLabel.js';

/**
 * A transaction stand-in that records each query and answers with the next
 * queued result (or no rows once the queue is empty).
 * @param {unknown[][]} results
 */
function transactionReturning(...results) {
  /** @type {{text: string, values: unknown[]}[]} */
  const queries = [];
  /** @type {any} */
  const tx = async (/** @type {TemplateStringsArray} */ strings, ...values) => {
    queries.push({ text: strings.join('?'), values });
    return results.shift() ?? [];
  };
  return { tx, queries };
}

describe('ensureSpamLabel', () => {
  test('creates or reuses the system Spam label for the message owner and returns its id', async () => {
    const { tx, queries } = transactionReturning([{ id: 'label-1' }]);
    expect(await ensureSpamLabel(tx, 'message-1')).toBe('label-1');
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain('INSERT INTO labels');
    expect(queries[0].text).toContain("WHERE labels.kind = 'system'");
    expect(queries[0].values).toEqual(['message-1']);
  });

  test('returns null when the owner already has a non-system label of that name', async () => {
    const { tx } = transactionReturning([]);
    expect(await ensureSpamLabel(tx, 'message-1')).toBeNull();
  });
});
