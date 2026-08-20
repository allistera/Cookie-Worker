import { describe, expect, test, vi } from 'vitest';
import { verifyAccessToken } from '../src/auth.js';

const env = { AUTH0_DOMAIN: 'tenant.example.auth0.com', AUTH0_AUDIENCE: 'https://cookie-web/api' };
const request = new Request('https://cookie-web-labels.example/labels', {
  headers: { Authorization: 'Bearer signed-token' },
});

/**
 * A tagged-template-shaped mock, loosely typed so it can stand in for a real
 * postgres.js Sql client wherever verifyAccessToken expects one.
 *
 * @param {(...args: any[]) => unknown} impl
 * @returns {any}
 */
function fakeSql(impl) {
  return vi.fn(impl);
}

/**
 * jose's real jwtVerify/JWKS types are too precise for a hand-rolled test
 * double to satisfy structurally — loosely typed so a plain mock function
 * can stand in for jwtVerify, and the test can still assert on it directly.
 *
 * @param {(...args: any[]) => unknown} jwtVerify
 * @returns {any}
 */
function fakeJoseOverrides(jwtVerify) {
  return { jwks: {}, jwtVerify };
}

describe('verifyAccessToken identity binding', () => {
  test('returns the mailbox provisioned for the verified subject, ignoring email claims', async () => {
    const jwtVerify = vi.fn(async () => ({
      payload: {
        sub: 'auth0|stable-subject',
        email: 'attacker@example.com',
        'https://cookie-web/email': 'attacker@example.com',
      },
    }));
    const sql = fakeSql(async () => [
      { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.com' },
    ]);

    await expect(
      verifyAccessToken(request, env, sql, fakeJoseOverrides(jwtVerify)),
    ).resolves.toMatchObject({
      sub: 'auth0|stable-subject',
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'owner@example.com',
    });
    expect(sql.mock.calls[0][1]).toBe('auth0|stable-subject');
    expect(jwtVerify).toHaveBeenCalledWith(
      'signed-token',
      {},
      expect.objectContaining({
        issuer: 'https://tenant.example.auth0.com/',
        audience: 'https://cookie-web/api',
        algorithms: ['RS256'],
      }),
    );
  });

  test('rejects a valid tenant token whose subject is not provisioned', async () => {
    const jwtVerify = vi.fn(async () => ({ payload: { sub: 'auth0|unknown' } }));
    const sql = fakeSql(async () => []);

    await expect(
      verifyAccessToken(request, env, sql, fakeJoseOverrides(jwtVerify)),
    ).rejects.toThrow(/not provisioned/i);
  });

  test('rejects a token without an immutable subject even if it has an email', async () => {
    const jwtVerify = vi.fn(async () => ({ payload: { email: 'owner@example.com' } }));
    const sql = fakeSql(() => undefined);

    await expect(
      verifyAccessToken(request, env, sql, fakeJoseOverrides(jwtVerify)),
    ).rejects.toThrow(/no subject/i);
    expect(sql).not.toHaveBeenCalled();
  });

  test('rejects a missing bearer token before any lookup', async () => {
    const anonymous = new Request('https://cookie-web-labels.example/labels');
    const sql = fakeSql(() => undefined);
    await expect(verifyAccessToken(anonymous, env, sql)).rejects.toThrow(/bearer token/i);
    expect(sql).not.toHaveBeenCalled();
  });

  test('requires AUTH0_DOMAIN and AUTH0_AUDIENCE to be configured', async () => {
    const sql = fakeSql(() => undefined);
    await expect(verifyAccessToken(request, {}, sql)).rejects.toThrow(/AUTH0_DOMAIN/);
    expect(sql).not.toHaveBeenCalled();
  });
});
