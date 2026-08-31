import { describe, expect, it, vi } from 'vitest';
import { exponentialDelayMs, isRetryableMeiliError, retryMeiliCall } from './meiliRetry.js';

function apiError(status) {
  return { name: 'MeilisearchApiError', response: { status } };
}

describe('isRetryableMeiliError', () => {
  it('retries a network/fetch failure', () => {
    expect(isRetryableMeiliError({ name: 'MeilisearchRequestError' })).toBe(true);
  });

  it('retries a 5xx API error', () => {
    expect(isRetryableMeiliError(apiError(500))).toBe(true);
    expect(isRetryableMeiliError(apiError(520))).toBe(true);
  });

  it('does not retry a 4xx API error', () => {
    expect(isRetryableMeiliError(apiError(400))).toBe(false);
    expect(isRetryableMeiliError(apiError(404))).toBe(false);
  });

  it('does not retry an unrecognized error shape', () => {
    expect(isRetryableMeiliError(new Error('boom'))).toBe(false);
    expect(isRetryableMeiliError(null)).toBe(false);
  });
});

describe('exponentialDelayMs', () => {
  it('doubles the delay each attempt', () => {
    expect(exponentialDelayMs(1, 1000)).toBe(1000);
    expect(exponentialDelayMs(2, 1000)).toBe(2000);
    expect(exponentialDelayMs(3, 1000)).toBe(4000);
  });
});

describe('retryMeiliCall', () => {
  it('succeeds on the first try without sleeping', async () => {
    const sleep = vi.fn();
    const operation = vi.fn(async () => 'ok');

    await expect(retryMeiliCall(operation, { sleep })).resolves.toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a 5xx failure with exponential delays, then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi
      .fn()
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(500))
      .mockResolvedValueOnce('ok');

    await expect(retryMeiliCall(operation, { baseDelayMs: 100, sleep })).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it('does not retry a 4xx failure', async () => {
    const sleep = vi.fn();
    const operation = vi.fn(async () => {
      throw apiError(400);
    });

    await expect(retryMeiliCall(operation, { sleep })).rejects.toMatchObject({
      response: { status: 400 },
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up and rethrows after exhausting attempts', async () => {
    const sleep = vi.fn(async () => {});
    const error = apiError(500);
    const operation = vi.fn(async () => {
      throw error;
    });

    await expect(retryMeiliCall(operation, { baseDelayMs: 1, sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
