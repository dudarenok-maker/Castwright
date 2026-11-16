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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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

test('withReportExclusionNodeOptions always appends both flags, last one wins', () => {
  // A whitespace split cannot tell a flag from text inside a quoted value, or
  // see a later negation, so it never skips: node takes the last occurrence.
  const quoted = withReportExclusionNodeOptions({
    NODE_OPTIONS: '--max-old-space-size=512 --title "cw --report-exclude-env p5"',
  });
  assert.equal(
    quoted.NODE_OPTIONS,
    '--max-old-space-size=512 --title "cw --report-exclude-env p5" --report-exclude-env --report-exclude-network',
  );
  const negated = withReportExclusionNodeOptions({
    NODE_OPTIONS: '--report-exclude-env --no-report-exclude-env',
  });
  assert.ok(
    negated.NODE_OPTIONS.endsWith('--no-report-exclude-env --report-exclude-env --report-exclude-network'),
  );
  const partial = withReportExclusionNodeOptions({ NODE_OPTIONS: '--report-exclude-env' });
  assert.equal(
    partial.NODE_OPTIONS,
    '--report-exclude-env --report-exclude-env --report-exclude-network',
  );
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

// The pins above are textual and the helpers are tested alone, so run the REAL
// launcher end to end: copy dev-server.mjs + scripts/lib/ into a temp root with
// a fake `tsx` (server/node_modules/tsx, exports ./cli) that records its argv
// and NODE_OPTIONS and exits with a chosen code. This is what catches an env
// override between devServerCommand and the child (e.g. `options.env = ...`).
function runDevServerAgainstFakeTsx({ exitCode, nodeOptions }) {
  const root = mkdtempSync(join(tmpdir(), 'dev-server-fixture-'));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(join(here, '..', 'dev-server.mjs'), join(root, 'scripts', 'dev-server.mjs'));
    cpSync(join(here, '..', 'lib'), join(root, 'scripts', 'lib'), { recursive: true });
    const tsx = join(root, 'server', 'node_modules', 'tsx');
    mkdirSync(tsx, { recursive: true });
    writeFileSync(join(root, 'server', 'package.json'), '{"name":"fixture-server"}');
    writeFileSync(
      join(tsx, 'package.json'),
      JSON.stringify({ name: 'tsx', version: '0.0.0', exports: { './cli': './cli.mjs' } }),
    );
    writeFileSync(
      join(tsx, 'cli.mjs'),
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, 'record.json'))},
  JSON.stringify({ argv: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS, cwd: process.cwd() }));
process.exit(${exitCode});`,
    );
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'dev-server.mjs')], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    return { result, record: JSON.parse(readFileSync(join(root, 'record.json'), 'utf8')), root };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the real launcher hands tsx the flags on argv and in NODE_OPTIONS, and passes its exit code through', () => {
  const { result, record, root } = runDevServerAgainstFakeTsx({ exitCode: 7 });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(record.argv, [
    'watch',
    '--include=.env',
    '--report-exclude-env',
    '--report-exclude-network',
    'src/index.ts',
  ]);
  assert.equal(record.nodeOptions, '--report-exclude-env --report-exclude-network');
  assert.ok(record.cwd.toLowerCase().endsWith('server'), `tsx ran in ${record.cwd} (${root})`);
});

test('the real launcher appends to the caller\'s NODE_OPTIONS and exits 0 when tsx does', () => {
  const { result, record } = runDevServerAgainstFakeTsx({
    exitCode: 0,
    nodeOptions: '--max-old-space-size=512',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    record.nodeOptions,
    '--max-old-space-size=512 --report-exclude-env --report-exclude-network',
  );
});
