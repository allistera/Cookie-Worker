#!/usr/bin/env node

// Bundles aws/server.js and the Workers listed in aws/workers.js into dist/aws/, the package of the
// Lambda Web Function: index.js at the root, where the runtime looks for it, and a package.json that
// marks it as an ES module.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { AWS_WORKERS } from '../aws/workers.js';

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The `vars` of a Worker's wrangler.jsonc: its non-secret configuration, bundled with its code as
 * Wrangler does.
 *
 * @param {string} repositoryRoot
 * @param {string} name
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readWorkerVars(repositoryRoot, name) {
  const configPath = path.join(repositoryRoot, 'workers', name, 'wrangler.jsonc');
  /** @type {import('jsonc-parser').ParseError[]} */
  const errors = [];
  const configuration = parse(await readFile(configPath, 'utf8'), errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) {
    const detail = errors.map((error) => printParseErrorCode(error.error)).join(', ');
    throw new Error(`Invalid Wrangler configuration at ${configPath}: ${detail}`);
  }
  return configuration?.vars ?? {};
}

/**
 * The bundle's entry module: one import per Worker, then the server with one route each.
 *
 * @param {{name: string, hostname: string, secrets: string[], vars: Record<string, unknown>}[]} workers
 * @param {string} version
 */
export function entrySource(workers, version) {
  return [
    "import { serve, workerEnv } from './aws/server.js';",
    ...workers.map(
      ({ name }, index) => `import worker${index} from './workers/${name}/src/worker.js';`,
    ),
    '',
    'serve(',
    '  [',
    ...workers.map(
      ({ hostname, secrets, vars }, index) =>
        `    { hostname: ${JSON.stringify(hostname)}, worker: worker${index}, ` +
        `env: workerEnv(${JSON.stringify(vars)}, ${JSON.stringify(secrets)}, process.env) },`,
    ),
    '  ],',
    `  { version: ${JSON.stringify(version)} },`,
    ');',
    '',
  ].join('\n');
}

/** @type {import('esbuild').Plugin} */
const cloudflareWorkersShim = {
  name: 'cloudflare-workers-shim',
  setup(pluginBuild) {
    // esbuild runs this filter as a Go regular expression, which has no `u` flag.
    pluginBuild.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
      path: path.join(REPOSITORY_ROOT, 'aws', 'cloudflare-workers.js'),
    }));
  },
};

async function main() {
  const workers = await Promise.all(
    AWS_WORKERS.map(async (worker) => ({
      ...worker,
      vars: await readWorkerVars(REPOSITORY_ROOT, worker.name),
    })),
  );
  const version = process.env.GITHUB_SHA ?? 'local';
  const outDirectory = path.join(REPOSITORY_ROOT, 'dist', 'aws');
  await rm(outDirectory, { recursive: true, force: true });
  await mkdir(outDirectory, { recursive: true });
  await build({
    stdin: {
      contents: entrySource(workers, version),
      resolveDir: REPOSITORY_ROOT,
      sourcefile: 'aws-entry.js',
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outfile: path.join(outDirectory, 'index.js'),
    plugins: [cloudflareWorkersShim],
    logLevel: 'warning',
  });
  await writeFile(path.join(outDirectory, 'package.json'), '{ "type": "module" }\n');
  console.log(
    `Built dist/aws/index.js at ${version} for ${workers.map(({ name }) => name).join(', ')}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
