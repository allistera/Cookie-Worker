import { describe, expect, test, vi } from 'vitest';
import { errors } from 'jose';
import { verifyAccessToken } from './auth-jwt.js';
import { runAsInternalCaller } from './internal-identity.js';

const env = { AUTH0_DOMAIN: 'tenant.example.auth0.com', AUTH0_AUDIENCE: 'https://cookie-web/api' };
const request = new Request('https://cookie-web-api.example/labels', {
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

  test('surfaces a dropped connection during the mailbox lookup as the failure cause', async () => {
    const jwtVerify = vi.fn(async () => ({ payload: { sub: 'auth0|socket-drop' } }));
    const dropped = Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' });
    const sql = fakeSql(async () => {
      throw dropped;
    });

    const failure = await verifyAccessToken(request, env, sql, fakeJoseOverrides(jwtVerify)).then(
      () => null,
      (error) => error,
    );

    expect(failure).toMatchObject({ name: 'AuthFailure', status: 503 });
    expect(failure.cause).toBe(dropped);
  });

  test('reuses a recently resolved subject without another mailbox lookup', async () => {
    const jwtVerify = vi.fn(async () => ({ payload: { sub: 'auth0|cached-subject' } }));
    const sql = fakeSql(async () => [
      { id: '22222222-2222-4222-8222-222222222222', email: 'owner@example.com' },
    ]);

    const first = await verifyAccessToken(request, env, sql, fakeJoseOverrides(jwtVerify));
    const second = await verifyAccessToken(
      request,
      env,
      fakeSql(async () => []),
      fakeJoseOverrides(jwtVerify),
    );

    expect(sql).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ userId: first.userId, email: first.email });
  });

  test('does not cache a failed mailbox lookup', async () => {
    const jwtVerify = vi.fn(async () => ({ payload: { sub: 'auth0|retry-after-drop' } }));
    const failing = fakeSql(async () => {
      throw Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' });
    });
    await expect(
      verifyAccessToken(request, env, failing, fakeJoseOverrides(jwtVerify)),
    ).rejects.toMatchObject({ status: 503 });

    const sql = fakeSql(async () => [
      { id: '33333333-3333-4333-8333-333333333333', email: 'owner@example.com' },
    ]);
    await expect(
      verifyAccessToken(request, env, sql, fakeJoseOverrides(jwtVerify)),
    ).resolves.toMatchObject({ userId: '33333333-3333-4333-8333-333333333333' });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  // A custom domain changes the issuer but not the signing keys. Listing both
  // domains accepts tokens minted by either while clients move over, with
  // the JWKS fetched from the first (the custom domain going forward).
  test('accepts tokens from every listed domain and reads keys from the first', async () => {
    const listedEnv = {
      ...env,
      AUTH0_DOMAIN: 'auth.example.com, tenant.example.auth0.com',
    };
    const jwtVerify = vi.fn(async () => ({ payload: { sub: 'auth0|listed-domains' } }));
    const sql = fakeSql(async () => [
      { id: '44444444-4444-4444-8444-444444444444', email: 'owner@example.com' },
    ]);

    await expect(
      verifyAccessToken(request, listedEnv, sql, fakeJoseOverrides(jwtVerify)),
    ).resolves.toMatchObject({ userId: '44444444-4444-4444-8444-444444444444' });
    expect(jwtVerify).toHaveBeenCalledWith(
      'signed-token',
      expect.anything(),
      expect.objectContaining({
        issuer: ['https://auth.example.com/', 'https://tenant.example.auth0.com/'],
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

  // A key-set outage says nothing about the token: a 401 would sign a valid
  // session out, so the client is told to retry instead.
  test.each([
    ['a JWKS timeout', new errors.JWKSTimeout()],
    ['a network failure', new TypeError('fetch failed')],
    [
      'a non-200 JWKS response',
      new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'),
    ],
    ['a malformed key set', new errors.JWKSInvalid('JSON Web Key Set malformed')],
  ])('answers 503 for %s', async (_name, failure) => {
    const jwtVerify = vi.fn(async () => {
      throw failure;
    });
    const sql = fakeSql(() => undefined);

    await expect(
      verifyAccessToken(request, env, sql, fakeJoseOverrides(jwtVerify)),
    ).rejects.toMatchObject({ status: 503, cause: failure });
    expect(sql).not.toHaveBeenCalled();
  });

  test.each([
    ['an expired token', new errors.JWTExpired('"exp" claim timestamp check failed', {})],
    ['a bad signature', new errors.JWSSignatureVerificationFailed()],
    ['an unknown key id', new errors.JWKSNoMatchingKey()],
    ['a malformed token', new errors.JWSInvalid('Invalid Compact JWS')],
  ])('keeps 401 for %s', async (_name, failure) => {
    const jwtVerify = vi.fn(async () => {
      throw failure;
    });

    await expect(
      verifyAccessToken(
        request,
        env,
        fakeSql(() => undefined),
        fakeJoseOverrides(jwtVerify),
      ),
    ).rejects.toMatchObject({ status: 401, message: 'Invalid access token' });
  });

  test('rejects a missing bearer token before any lookup', async () => {
    const anonymous = new Request('https://cookie-web-api.example/labels');
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

describe('internal callers', () => {
  test('an internal caller skips JWT verification and the users lookup', async () => {
    const sql = vi.fn();
    const internalRequest = new Request('https://internal.cookie/emails');
    const result = await runAsInternalCaller({ userId: 'u-1', email: 'a@example.com' }, () =>
      verifyAccessToken(
        internalRequest,
        { AUTH0_DOMAIN: 'x.example', AUTH0_AUDIENCE: 'aud' },
        /** @type {any} */ (sql),
      ),
    );
    expect(result).toMatchObject({ userId: 'u-1', email: 'a@example.com', internal: true });
    expect(sql).not.toHaveBeenCalled();
  });

  test('no header can claim an internal identity outside the scope', async () => {
    const spoofed = new Request('https://emails-api.example/emails', {
      headers: { 'X-Cookie-Internal-User': 'u-1', 'X-Internal-User': 'u-1' },
    });
    await expect(
      verifyAccessToken(
        spoofed,
        { AUTH0_DOMAIN: 'x.example', AUTH0_AUDIENCE: 'aud' },
        /** @type {any} */ (vi.fn()),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
