import { expect, test, vi } from 'vitest';

// Exercise the deployed HTTP exports without initializing observability.
vi.mock('@sentry/cloudflare', async (original) => ({
  ...(await original()),
  withSentry: (_options, worker) => worker,
}));

test.each([
  'cookie-web-ai',
  'cookie-web-calendar',
  'cookie-web-drafts',
  'cookie-web-emails',
  'cookie-web-labels',
  'cookie-web-messages',
  'cookie-web-notifications',
  'cookie-web-search',
  'cookie-web-receipts',
  'cookie-web-tasks',
  'cookie-web-send',
  'cookie-mcp',
])('%s exposes unauthenticated liveness before dependency setup', async (name) => {
  const { default: worker } = await import(`../../workers/${name}/src/worker.js`);
  const response = await worker.fetch(
    new Request('https://worker.test/health'),
    { PERFORMANCE_SAMPLE_RATE: 0 },
    {},
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});
