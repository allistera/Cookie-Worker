import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createTypecheckCommands,
  createWranglerCommands,
  discoverWorkers,
} from '../../scripts/workers.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

async function repositoryWithWorkers(...workers) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'cookie-workers-'));
  temporaryDirectories.push(repositoryRoot);
  for (const worker of workers) {
    const directory = path.join(repositoryRoot, 'workers', worker);
    await mkdir(path.join(directory, 'src'), { recursive: true });
    await writeFile(path.join(directory, 'wrangler.jsonc'), JSON.stringify({
      name: worker,
      main: 'src/index.js',
    }));
    await writeFile(path.join(directory, 'src/index.js'), 'export default {};\n');
    await writeFile(path.join(directory, 'jsconfig.json'), '{}\n');
  }
  return repositoryRoot;
}

describe('worker repository interface', () => {
  test('discovers worker capsules in deterministic order', async () => {
    const repositoryRoot = await repositoryWithWorkers('second-worker', 'first-worker');

    await expect(discoverWorkers(repositoryRoot)).resolves.toEqual([
      expect.objectContaining({ id: 'first-worker' }),
      expect.objectContaining({ id: 'second-worker' }),
    ]);
  });

  test('builds one multi-config dev command and one dry run per worker', async () => {
    const repositoryRoot = await repositoryWithWorkers('mail-app-ingest', 'queue-consumer');

    await expect(createWranglerCommands({
      repositoryRoot,
      action: 'dev',
      target: '--all',
    })).resolves.toEqual([{
      worker: 'all',
      args: [
        'dev',
        '--config', 'workers/mail-app-ingest/wrangler.jsonc',
        '--config', 'workers/queue-consumer/wrangler.jsonc',
      ],
    }]);

    const dryRuns = await createWranglerCommands({
      repositoryRoot,
      action: 'dry-run',
      target: '--all',
    });
    expect(dryRuns).toEqual([
      {
        worker: 'mail-app-ingest',
        args: [
          'deploy',
          '--config', 'workers/mail-app-ingest/wrangler.jsonc',
          '--dry-run',
        ],
      },
      {
        worker: 'queue-consumer',
        args: [
          'deploy',
          '--config', 'workers/queue-consumer/wrangler.jsonc',
          '--dry-run',
        ],
      },
    ]);
  });

  test('rejects an unknown worker before constructing a Wrangler command', async () => {
    const repositoryRoot = await repositoryWithWorkers('mail-app-ingest');

    await expect(createWranglerCommands({
      repositoryRoot,
      action: 'deploy',
      target: 'missing-worker',
    })).rejects.toThrow('Unknown worker "missing-worker". Available workers: mail-app-ingest');
  });

  test('generates types without loading developer secrets', async () => {
    const repositoryRoot = await repositoryWithWorkers('data-enricher');

    await expect(createWranglerCommands({
      repositoryRoot,
      action: 'types',
      target: '--all',
    })).resolves.toEqual([{
      worker: 'data-enricher',
      args: [
        'types',
        'workers/data-enricher/worker-configuration.d.ts',
        '--config', 'workers/data-enricher/wrangler.jsonc',
        '--env-file', '.wrangler-types.env',
        '--include-runtime=false',
      ],
    }]);
  });

  test('isolates TypeScript checks per Worker capsule', async () => {
    const repositoryRoot = await repositoryWithWorkers('mail-app-ingest', 'queue-consumer');

    await expect(createTypecheckCommands(repositoryRoot)).resolves.toEqual([
      {
        worker: 'mail-app-ingest',
        args: ['-p', path.join(repositoryRoot, 'workers/mail-app-ingest/jsconfig.json')],
      },
      {
        worker: 'queue-consumer',
        args: ['-p', path.join(repositoryRoot, 'workers/queue-consumer/jsconfig.json')],
      },
    ]);
  });

  test('skips TypeScript checks for Python worker capsules', async () => {
    const repositoryRoot = await repositoryWithWorkers('mail-app-ingest');
    const directory = path.join(repositoryRoot, 'workers', 'data-enricher');
    await mkdir(path.join(directory, 'src'), { recursive: true });
    await writeFile(path.join(directory, 'wrangler.jsonc'), JSON.stringify({
      name: 'data-enricher',
      main: 'src/entry.py',
    }));
    await writeFile(path.join(directory, 'src/entry.py'), 'print("hello world")\n');

    await expect(discoverWorkers(repositoryRoot)).resolves.toEqual([
      expect.objectContaining({ id: 'data-enricher' }),
      expect.objectContaining({ id: 'mail-app-ingest' }),
    ]);
    await expect(createTypecheckCommands(repositoryRoot)).resolves.toEqual([
      {
        worker: 'mail-app-ingest',
        args: ['-p', path.join(repositoryRoot, 'workers/mail-app-ingest/jsconfig.json')],
      },
    ]);
  });

  test('rejects a capsule whose directory would deploy a different Worker name', async () => {
    const repositoryRoot = await repositoryWithWorkers('mail-app-ingest');
    await writeFile(
      path.join(repositoryRoot, 'workers/mail-app-ingest/wrangler.jsonc'),
      JSON.stringify({ name: 'other-worker', main: 'src/index.js' }),
    );

    await expect(discoverWorkers(repositoryRoot)).rejects.toThrow(
      'Worker directory "mail-app-ingest" must match Wrangler name "other-worker"',
    );
  });
});
