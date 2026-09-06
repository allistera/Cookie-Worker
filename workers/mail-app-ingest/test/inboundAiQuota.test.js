import { beforeEach, expect, test, vi } from 'vitest';
import { allowRequest } from '../../../shared/rate-limit.js';
import { claimInboundAiRequest, InboundAiQuotaExceeded } from '../src/inboundAiQuota.js';
vi.mock('../../../shared/rate-limit.js', () => ({ allowRequest: vi.fn() }));
beforeEach(() => {
  vi.mocked(allowRequest).mockReset();
});

test('claims the shared daily budget against the mailbox owner', async () => {
  const sql = /** @type {any} */ (vi.fn());
  vi.mocked(allowRequest).mockResolvedValue(true);
  await claimInboundAiRequest(sql, 'owner');
  expect(allowRequest).toHaveBeenCalledWith(sql, 'owner', 'inbound-ai', {
    limit: 200,
    windowMs: 86400000,
  });
});

test('refuses work when the budget is spent or the owner is missing', async () => {
  const sql = /** @type {any} */ (vi.fn());
  vi.mocked(allowRequest).mockResolvedValue(false);
  await expect(claimInboundAiRequest(sql, 'owner')).rejects.toBeInstanceOf(InboundAiQuotaExceeded);
  await expect(claimInboundAiRequest(sql, '')).rejects.toBeInstanceOf(InboundAiQuotaExceeded);
  expect(allowRequest).toHaveBeenCalledTimes(1);
});

test('does not allow provider work if the quota database is unavailable', async () => {
  vi.mocked(allowRequest).mockRejectedValue(new Error('Unavailable'));
  await expect(claimInboundAiRequest(/** @type {any} */ (vi.fn()), 'owner')).rejects.toThrow(
    'Unavailable',
  );
});
