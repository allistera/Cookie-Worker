/// <reference types="vite/client" />
import postgres from 'postgres';
import { expect, test, vi } from 'vitest';
import { saveNtfySubscription, sendNtfyTest } from '../src/ntfy.js';
import { stubPublicDns } from './helpers.js';

const databaseUrl = import.meta.env.SCREENING_RETENTION_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)('notification credentials follow the saved server URL', async () => {
  stubPublicDns();
  const database = postgres(/** @type {string} */ (databaseUrl), { max: 1 });
  const options = {
    tokenKey: btoa(String.fromCharCode(...new Uint8Array(32))),
    fetchImpl: vi.fn(async (_url, _init) => new Response(null, { status: 200 })),
  };
  const first = 'https://first.example/ntfy';
  const second = 'https://second.example/ntfy';
  const userId = 'example-user';
  try {
    await database.begin(async (tx) => {
      const sql = /** @type {import('postgres').Sql} */ (/** @type {unknown} */ (tx));
      await sql`CREATE TEMP TABLE ntfy_subscriptions (
        user_id text PRIMARY KEY, server_url text NOT NULL, topic text NOT NULL,
        enabled boolean NOT NULL, access_token_encrypted text, token_hint text NOT NULL DEFAULT '',
        updated_at timestamptz
      ) ON COMMIT DROP`;
      await saveNtfySubscription(
        sql,
        userId,
        { serverUrl: first, topic: 'mail', accessToken: 'test-first' },
        options,
      );

      // Changing only the topic and the spelling of the same URL retains the token.
      const retained = await saveNtfySubscription(
        sql,
        userId,
        { serverUrl: first + '/', topic: 'news' },
        options,
      );
      expect(retained.tokenHint).toBe('irst');
      await sendNtfyTest(sql, userId, options);
      expect(options.fetchImpl).toHaveBeenLastCalledWith(
        first + '/news',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-first' }),
        }),
      );

      const moved = await saveNtfySubscription(
        sql,
        userId,
        { serverUrl: second, topic: 'news' },
        options,
      );
      expect(moved.tokenHint).toBe('');
      await sendNtfyTest(sql, userId, options);
      const [target, request] = options.fetchImpl.mock.calls.at(-1) ?? [];
      expect(target).toBe(second + '/news');
      expect(request.headers).not.toHaveProperty('Authorization');

      const replaced = await saveNtfySubscription(
        sql,
        userId,
        { serverUrl: first, topic: 'news', accessToken: 'test-next' },
        options,
      );
      expect(replaced.tokenHint).toBe('next');
      await sendNtfyTest(sql, userId, options);
      expect(options.fetchImpl).toHaveBeenLastCalledWith(
        first + '/news',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer test-next' }),
        }),
      );
    });
  } finally {
    vi.unstubAllGlobals();
    await database.end();
  }
});
