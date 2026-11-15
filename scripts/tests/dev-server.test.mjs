// #4054: the dev launcher (server/package.json `dev`, so `npm start`, `npm run
// dev`, `dev:mock`, `dev:lan`) must start node with the report-exclusion flags
// in NODE_OPTIONS, not only on the command line. tsx's esbuild runs its sync API
// in a Worker started with `execArgv: []`, and a Worker parses its options from
// its own execArgv plus the NODE_OPTIONS in its env, never the parent's command
// line — so without NODE_OPTIONS that worker's sub-report in an old-generation
// OOM carries the whole environment and the network interfaces.
//
// Importing dev-server.mjs must NOT spawn tsx — its CLI half is behind an
// invoked-directly check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REPORT_EXCLUSION_FLAGS,
  withReportExclusionNodeOptions,
} from '../lib/report-exclusion.mjs';
import { devServerCommand } from '../dev-server.mjs';

test('withReportExclusionNodeOptions sets both flags when NODE_OPTIONS is unset', () => {
  const env = withReportExclusionNodeOptions({ KEEP: '1' });
  assert.equal(env.NODE_OPTIONS, '--report-exclude-env --report-exclude-network');
  assert.equal(env.KEEP, '1');
});

test('withReportExclusionNodeOptions appends to an existing NODE_OPTIONS, never clobbers it', () => {
  const env = withReportExclusionNodeOptions({ NODE_OPTIONS: '--max-old-space-size=8192' });
  assert.equal(
    env.NODE_OPTIONS,
    '--max-old-space-size=8192 --report-exclude-env --report-exclude-network',
  );
});

test('withReportExclusionNodeOptions is idempotent and adds only a missing flag', () => {
  const once = withReportExclusionNodeOptions({ NODE_OPTIONS: '--inspect' });
  assert.deepEqual(withReportExclusionNodeOptions(once), once);
  const partial = withReportExclusionNodeOptions({ NODE_OPTIONS: '--report-exclude-env' });
  assert.equal(partial.NODE_OPTIONS, '--report-exclude-env --report-exclude-network');
});

test('withReportExclusionNodeOptions does not mutate its input', () => {
  const base = { NODE_OPTIONS: '--inspect' };
  withReportExclusionNodeOptions(base);
  assert.deepEqual(base, { NODE_OPTIONS: '--inspect' });
});

test('REPORT_EXCLUSION_FLAGS are the two flags the server gate requires', () => {
  assert.deepEqual(REPORT_EXCLUSION_FLAGS, ['--report-exclude-env', '--report-exclude-network']);
});

test('devServerCommand runs tsx watch on src/index.ts with the flags on the command line too', () => {
  const { file, args, options } = devServerCommand(
    '/srv',
    { PATH: 'p' },
    () => '/srv/node_modules/tsx/dist/cli.mjs',
  );
  assert.equal(file, process.execPath);
  assert.deepEqual(args, [
    '/srv/node_modules/tsx/dist/cli.mjs',
    'watch',
    '--include=.env',
    '--report-exclude-env',
    '--report-exclude-network',
    'src/index.ts',
  ]);
  assert.equal(options.cwd, '/srv');
  assert.equal(options.env.PATH, 'p');
  assert.equal(options.env.NODE_OPTIONS, '--report-exclude-env --report-exclude-network');
});

// The helpers above are tested alone, so pin the CLI half's spawn too: it must
// spawn devServerCommand's file/args/options and nothing else. Comments are
// stripped first so a commented-out call can't pass.
test('the CLI spawns exactly what devServerCommand builds, with the process env', () => {
  const src = readFileSync(new URL('../dev-server.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.match(code, /devServerCommand\(serverDir, process\.env\)/);
  assert.match(code, /spawn\(file, args, \{ \.\.\.options, windowsHide: true \}\)/);
  assert.equal(code.match(/\bspawn\(/g)?.length, 1, 'one spawn, so the pin covers it');
});
