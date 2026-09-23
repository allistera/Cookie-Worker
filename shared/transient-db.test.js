import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTransientDbError, retryWithFreshClient } from './transient-db.js';

describe('isTransientDbError', () => {
  it.each([
    ['a dropped Hyperdrive socket', new Error('Network connection lost.')],
    [
      'a connect timeout',
      Object.assign(new Error('write CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' }),
    ],
    ['a closed connection', Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' })],
    ['a connection failure', Object.assign(new Error('database down'), { code: '08001' })],
    ['a timed-out write', new Error('write timed out')],
    [
      'a wrapped transient cause',
      new Error('Mailbox lookup failed', {
        cause: Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' }),
      }),
    ],
  ])('matches %s', (_label, error) => {
    expect(isTransientDbError(error)).toBe(true);
  });

  it.each([
    ['a syntax error', new Error('syntax error at or near "SELEC"')],
    ['a constraint violation', Object.assign(new Error('duplicate key'), { code: '23505' })],
    ['a plain reset', new Error('connection reset')],
    ['a non-error', 'nope'],
  ])('leaves %s to fail', (_label, error) => {
    expect(isTransientDbError(error)).toBe(false);
  });
});

describe('retryWithFreshClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function client() {
    /** @type {any} */
    const sql = vi.fn();
    sql.end = vi.fn().mockResolvedValue(undefined);
    return sql;
  }

  it('gives a transient failure another go on a fresh client, ending both', async () => {
    vi.useFakeTimers();
    const clients = [client(), client()];
    const createClient = vi.fn().mockReturnValueOnce(clients[0]).mockReturnValueOnce(clients[1]);
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network connection lost.'))
      .mockResolvedValueOnce('done');

    const run = retryWithFreshClient(createClient, task, { baseDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);

    await expect(run).resolves.toBe('done');
    expect(task).toHaveBeenNthCalledWith(1, clients[0], 1);
    expect(task).toHaveBeenNthCalledWith(2, clients[1], 2);
    expect(clients[0].end).toHaveBeenCalledOnce();
    expect(clients[1].end).toHaveBeenCalledOnce();
  });

  it('leaves a permanent failure to fail once its client is ended', async () => {
    const sql = client();
    const task = vi.fn().mockRejectedValue(new Error('syntax error at or near "SELEC"'));

    await expect(retryWithFreshClient(() => sql, task)).rejects.toThrow('syntax error');
    expect(task).toHaveBeenCalledOnce();
    expect(sql.end).toHaveBeenCalledOnce();
  });

  it('gives up after the last attempt', async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' });
    const task = vi.fn().mockRejectedValue(error);

    const run = retryWithFreshClient(client, task, { attempts: 2, baseDelayMs: 10 });
    const rejection = expect(run).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('does not retry a client that cannot be created', async () => {
    const createClient = vi.fn(() => {
      throw new Error('database connection string is not valid');
    });

    await expect(retryWithFreshClient(createClient, vi.fn())).rejects.toThrow('not valid');
    expect(createClient).toHaveBeenCalledOnce();
  });
});
