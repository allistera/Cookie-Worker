import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { createHandler, drain, workerEnv } from '../../aws/server.js';
import { AWS_WORKERS } from '../../aws/workers.js';
import { serviceConfig } from '../../scripts/aws-service-config.mjs';
import { entrySource, readWorkerVars } from '../../scripts/build-aws.mjs';

// Exercise the deployed HTTP exports without initializing observability.
vi.mock('@sentry/cloudflare', async (original) => ({
  ...(await original()),
  withSentry: (_options, worker) => worker,
}));

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('AWS Web Function', () => {
  test('lists existing Workers, each on its own hostname under infinitywave.online', async () => {
    const hostnames = AWS_WORKERS.map(({ hostname }) => hostname);
    expect(new Set(hostnames).size).toBe(hostnames.length);
    for (const { name, hostname, secrets } of AWS_WORKERS) {
      await expect(
        access(path.join(repositoryRoot, 'workers', name, 'src/worker.js')),
      ).resolves.toBeUndefined();
      expect(hostname).toMatch(/^[a-z0-9-]+\.infinitywave\.online$/u);
      expect(secrets).not.toContain('DATABASE_URL');
    }
  });

  test('bundles each Worker with the vars of its wrangler.jsonc', async () => {
    const vars = await readWorkerVars(repositoryRoot, 'cookie-web-receipts');
    expect(vars).toMatchObject({ ALLOWED_ORIGIN: 'https://mail.infinitywave.online' });

    const source = entrySource(
      [{ name: 'cookie-web-receipts', hostname: 'receipts-api.example', secrets: ['A'], vars }],
      'abc123',
    );
    expect(source).toContain("import worker0 from './workers/cookie-web-receipts/src/worker.js';");
    expect(source).toContain(`workerEnv(${JSON.stringify(vars)}, ["A"], process.env)`);
    expect(source).toContain('{ version: "abc123" }');
  });

  test('sends every secret a revision needs and refuses to deploy without one', () => {
    const contract = { executionRoleArn: 'arn:aws:iam::1:role/r', logGroup: '/aws/lambda/web/x' };
    const workers = [{ secrets: ['SENTRY_DSN'] }, { secrets: ['SENTRY_DSN', 'OPENAI_API_KEY'] }];

    expect(
      serviceConfig(contract, workers, {
        DATABASE_URL: 'postgres://db',
        SENTRY_DSN: 'dsn',
        OPENAI_API_KEY: 'key',
        UNRELATED: 'not sent',
      }),
    ).toEqual({
      executionRoleArn: 'arn:aws:iam::1:role/r',
      timeoutSeconds: 300,
      maxConcurrencyPerEnvironment: 64,
      environmentVariables: {
        DATABASE_URL: 'postgres://db',
        OPENAI_API_KEY: 'key',
        SENTRY_DSN: 'dsn',
      },
      telemetryConfig: { loggingConfig: { logGroup: '/aws/lambda/web/x' } },
    });
    expect(() => serviceConfig(contract, workers, { SENTRY_DSN: 'dsn' })).toThrow(
      'Missing environment variables: DATABASE_URL, OPENAI_API_KEY',
    );
  });

  test('serves the receipts Worker unchanged behind the Node server', async () => {
    const name = 'cookie-web-receipts';
    const { default: worker } = await import(`../../workers/${name}/src/worker.js`);
    const vars = await readWorkerVars(repositoryRoot, name);
    const { handle, pending } = createHandler(
      [
        {
          hostname: 'receipts-api.infinitywave.online',
          worker,
          env: { ...workerEnv(vars, ['SENTRY_DSN'], {}), PERFORMANCE_SAMPLE_RATE: 0 },
        },
      ],
      { version: 'test' },
    );
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const server = createServer((req, res) => {
      handle(req, res).catch(() => res.destroy());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const headers = { 'x-forwarded-host': 'receipts-api.infinitywave.online' };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`, { headers });
      expect(await health.json()).toEqual({ status: 'ok' });

      // No database in this test: the image still goes back, and the open is attempted in the
      // background, where its failure is logged and never reaches the recipient.
      const pixel = await fetch(
        `http://127.0.0.1:${port}/read-receipts?token=7f3a1b2c-1d2e-4f50-9a6b-0c1d2e3f4a5b`,
        { headers: { ...headers, 'cf-connecting-ip': '198.51.100.7' } },
      );
      expect(pixel.status).toBe(200);
      expect(pixel.headers.get('content-type')).toBe('image/gif');
      expect((await pixel.arrayBuffer()).byteLength).toBeGreaterThan(0);
      await drain(pending, 1_000);
      expect(errorLog).toHaveBeenCalledWith(
        'GET /read-receipts (pixel) failed:',
        expect.any(Error),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
