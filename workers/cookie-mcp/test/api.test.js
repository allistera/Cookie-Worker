import { describe, expect, test, vi } from 'vitest';
import { ApiError, createApi } from '../src/api.js';

const identity = { userId: 'u-1', email: 'a@example.com' };

describe('createApi', () => {
  test('builds the path and query, passes identity, and returns the body on 2xx', async () => {
    const call = vi.fn(async () => ({ status: 200, body: { emails: [] } }));
    const api = createApi(/** @type {any} */ ({ EMAILS: { call } }), identity);
    await expect(
      api.emails.get('/emails', { folder: 'inbox', label: undefined, limit: 25 }),
    ).resolves.toEqual({ emails: [] });
    expect(call).toHaveBeenCalledWith(identity, {
      method: 'GET',
      path: '/emails?folder=inbox&limit=25',
      body: undefined,
    });
  });

  test('non-2xx responses throw ApiError with the API message and status', async () => {
    const call = vi.fn(async () => ({ status: 404, body: { error: 'Message not found' } }));
    const api = createApi(/** @type {any} */ ({ MESSAGES: { call } }), identity);
    await expect(api.messages.patch('/messages', { id: 'x' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'Message not found',
      service: 'messages',
    });
  });

  test('non-2xx responses keep the API error code', async () => {
    const call = vi.fn(async () => ({
      status: 403,
      body: {
        error: 'A send confirmation from Cookie is required',
        code: 'SEND_CONFIRMATION_REQUIRED',
      },
    }));
    const api = createApi(/** @type {any} */ ({ SEND: { call } }), identity);
    await expect(api.send.post('/send', {})).rejects.toMatchObject({
      status: 403,
      code: 'SEND_CONFIRMATION_REQUIRED',
    });
  });

  test('a missing error message falls back to the status', async () => {
    const call = vi.fn(async () => ({ status: 500, body: null }));
    const api = createApi(/** @type {any} */ ({ TASKS: { call } }), identity);
    const error = await api.tasks.get('/projects').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe('Request failed with status 500');
  });
});
