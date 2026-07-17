#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse, printParseErrorCode } from 'jsonc-parser';

const WORKER_ID = /^[a-z][a-z0-9-]*$/u;
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const USAGE = `Usage:
  npm run workers
  npm run dev -- <worker|--all> [Wrangler options]
  npm run dry-run -- <worker|--all> [Wrangler options]
  npm run types -- <worker|--all> [Wrangler options]
  npm run deploy -- <worker> [Wrangler options]`;

/**
 * The filesystem is the worker catalog: adding workers/<id>/wrangler.jsonc is
 * sufficient for every root command and CI check to discover it.
 *
 * @param {string} [repositoryRoot]
 */
export async function discoverWorkers(repositoryRoot = REPOSITORY_ROOT) {
  const workersDirectory = path.join(repositoryRoot, 'workers');
  let entries;
  try {
    entries = await readdir(workersDirectory, { withFileTypes: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw new Error(`No workers directory found at ${workersDirectory}`);
    }
    throw error;
  }

  const workers = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    if (!WORKER_ID.test(entry.name)) {
      throw new Error(`Invalid worker directory "${entry.name}"; use lowercase letters, numbers, and dashes`);
    }
    const directory = path.join(workersDirectory, entry.name);
    const configPath = path.join(directory, 'wrangler.jsonc');
    try {
      await access(configPath);
    } catch {
      continue;
    }
    const errors = [];
    const configuration = parse(await readFile(configPath, 'utf8'), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0 || !configuration || typeof configuration !== 'object') {
      const detail = errors.map((error) => printParseErrorCode(error.error)).join(', ');
      throw new Error(`Invalid Wrangler configuration at ${configPath}${detail ? `: ${detail}` : ''}`);
    }
    if (configuration.name !== entry.name) {
      throw new Error(`Worker directory "${entry.name}" must match Wrangler name "${configuration.name}"`);
    }
    if (typeof configuration.main !== 'string' || configuration.main.length === 0) {
      throw new Error(`Worker "${entry.name}" must declare a main entry point`);
    }
    const entryPath = path.resolve(directory, configuration.main);
    const relativeEntryPath = path.relative(directory, entryPath);
    if (
      relativeEntryPath === ''
      || relativeEntryPath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeEntryPath)
    ) {
      throw new Error(`Worker "${entry.name}" main entry point must stay inside its capsule`);
    }
    try {
      await access(entryPath);
    } catch {
      throw new Error(`Worker "${entry.name}" entry point does not exist: ${entryPath}`);
    }
    workers.push({
      id: entry.name,
      main: configuration.main,
      directory,
      configPath,
      typesPath: path.join(directory, 'worker-configuration.d.ts'),
      typecheckPath: path.join(directory, 'jsconfig.json'),
    });
  }

  if (workers.length === 0) {
    throw new Error(`No workers found under ${workersDirectory}`);
  }
  return workers;
}

/**
 * Each Worker gets an isolated TypeScript program because Wrangler's generated
 * declarations intentionally declare global Env symbols.
 *
 * @param {string} [repositoryRoot]
 */
export async function createTypecheckCommands(repositoryRoot = REPOSITORY_ROOT) {
  const workers = await discoverWorkers(repositoryRoot);
  const javascriptWorkers = workers.filter((worker) => !worker.main.endsWith('.py'));
  return Promise.all(javascriptWorkers.map(async (worker) => {
    try {
      await access(worker.typecheckPath);
    } catch {
      throw new Error(`Worker "${worker.id}" is missing ${worker.typecheckPath}`);
    }
    return { worker: worker.id, args: ['-p', worker.typecheckPath] };
  }));
}

/**
 * Build Wrangler invocations behind one small repository interface.
 *
 * @param {{repositoryRoot?: string, action: string, target?: string, extraArgs?: string[]}} options
 */
export async function createWranglerCommands({
  repositoryRoot = REPOSITORY_ROOT,
  action,
  target,
  extraArgs = [],
}) {
  const workers = await discoverWorkers(repositoryRoot);
  const relativePath = (filePath) => path.relative(repositoryRoot, filePath);
  if (!['dev', 'dry-run', 'types', 'deploy'].includes(action)) {
    throw new Error(`Unknown action "${action}"`);
  }
  if (!target) throw new Error(`The ${action} action requires a worker name or --all`);
  if (action === 'deploy' && target === '--all') {
    throw new Error('Deploy requires one explicit worker; deploying all workers is not supported');
  }

  let selected = workers;
  if (target !== '--all') {
    const worker = workers.find((candidate) => candidate.id === target);
    if (!worker) {
      throw new Error(`Unknown worker "${target}". Available workers: ${workers.map(({ id }) => id).join(', ')}`);
    }
    selected = [worker];
  }

  if (action === 'dev' && target === '--all') {
    return [{
      worker: 'all',
      args: [
        'dev',
        ...selected.flatMap(({ configPath }) => ['--config', relativePath(configPath)]),
        ...extraArgs,
      ],
    }];
  }

  return selected.map((worker) => {
    if (action === 'dry-run') {
      return {
        worker: worker.id,
        args: ['deploy', '--config', relativePath(worker.configPath), '--dry-run', ...extraArgs],
      };
    }
    if (action === 'types') {
      return {
        worker: worker.id,
        args: [
          'types',
          relativePath(worker.typesPath),
          '--config', relativePath(worker.configPath),
          '--include-runtime=false',
          ...extraArgs,
        ],
      };
    }
    return {
      worker: worker.id,
      args: [action, '--config', relativePath(worker.configPath), ...extraArgs],
    };
  });
}

async function main() {
  const [action, target, ...extraArgs] = process.argv.slice(2);
  if (!action || action === 'list') {
    for (const { id } of await discoverWorkers()) console.log(id);
    return;
  }

  const commands = await createWranglerCommands({ action, target, extraArgs });
  const executable = path.join(
    REPOSITORY_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
  );
  for (const command of commands) {
    console.log(`[${command.worker}] wrangler ${command.args.join(' ')}`);
    const result = spawnSync(executable, command.args, {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
  });
}
