import { afterEach, describe, expect, test, vi } from 'vitest';
import { retryWithBackoff } from './retry.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('retryWithBackoff', () => {
  test('succeeds on the first try', async () => {
    const operation = vi.fn(async () => 'ok');

    await expect(retryWithBackoff(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledWith(1);
  });

  test('retries and then succeeds', async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce('ok');

    const result = retryWithBackoff(operation, { baseDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toBe('ok');
    expect(operation).toHaveBeenNthCalledWith(1, 1);
    expect(operation).toHaveBeenNthCalledWith(2, 2);
  });

  test('rethrows after exhausting attempts', async () => {
    const error = new Error('persistent');
    const operation = vi.fn(async () => {
      throw error;
    });

    await expect(retryWithBackoff(operation, { baseDelayMs: 0 })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  test('does not retry when the error is not retryable', async () => {
    const operation = vi.fn(async () => {
      throw new Error('permanent');
    });

    await expect(
      retryWithBackoff(operation, {
        isRetryable: () => false,
      }),
    ).rejects.toThrow('permanent');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test('uses linearly growing backoff delays', async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockResolvedValueOnce('ok');

    const result = retryWithBackoff(operation, { baseDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('ok');
  });
});
