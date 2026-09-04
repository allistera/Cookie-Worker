import { describe, expect, it } from 'vitest';
import { isTransientDbError } from './transient-db.js';

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
