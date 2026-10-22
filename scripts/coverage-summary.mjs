import { appendFile, readFile } from 'node:fs/promises';

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (!summaryPath) throw new Error('GITHUB_STEP_SUMMARY is required');

const { total } = JSON.parse(await readFile('coverage/coverage-summary.json', 'utf8'));
const rows = [
  ['Lines', total.lines],
  ['Statements', total.statements],
  ['Functions', total.functions],
  ['Branches', total.branches],
].map(([label, metric]) => `| ${label} | ${metric.pct}% | ${metric.covered} / ${metric.total} |`);

await appendFile(
  summaryPath,
  [
    '## Test coverage',
    '',
    '| Metric | Coverage | Covered / Total |',
    '| --- | ---: | ---: |',
    ...rows,
    '',
    'Coverage is informational; no minimum percentage is required.',
    '',
    'Download the **unit-coverage** artifact and open `lcov-report/index.html` for the interactive per-file report. JSON and LCOV data are also included.',
    '',
  ].join('\n'),
);
