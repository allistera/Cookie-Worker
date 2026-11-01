#!/usr/bin/env node

// Prints the serviceConfig of a new Web Function revision as JSON, for
// .github/workflows/deploy-aws.yml. A revision is a full snapshot, so every setting is sent every
// time: a variable left out is simply unset in the new revision. Fails, naming the variable, when a
// secret is missing, and never prints a value anywhere else.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWS_WORKERS } from '../aws/workers.js';

/**
 * @param {{executionRoleArn: string, logGroup: string}} contract From Cookie-Infra's SSM parameters.
 * @param {{secrets: string[]}[]} workers
 * @param {Record<string, string | undefined>} processEnv
 */
export function serviceConfig({ executionRoleArn, logGroup }, workers, processEnv) {
  const names = [...new Set(['DATABASE_URL', ...workers.flatMap(({ secrets }) => secrets)])].sort();
  const missing = names.filter((name) => !processEnv[name]);
  if (!executionRoleArn || !logGroup) missing.unshift('EXECUTION_ROLE_ARN or LOG_GROUP');
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  return {
    executionRoleArn,
    // Requests through CloudFront give up after 60 seconds; the cron paths, called directly by
    // the pinger, may take longer.
    timeoutSeconds: 300,
    maxConcurrencyPerEnvironment: 64,
    environmentVariables: Object.fromEntries(names.map((name) => [name, processEnv[name]])),
    telemetryConfig: { loggingConfig: { logGroup } },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const contract = {
      executionRoleArn: process.env.EXECUTION_ROLE_ARN ?? '',
      logGroup: process.env.LOG_GROUP ?? '',
    };
    process.stdout.write(`${JSON.stringify(serviceConfig(contract, AWS_WORKERS, process.env))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
