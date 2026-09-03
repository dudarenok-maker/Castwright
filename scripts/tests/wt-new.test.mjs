// Tests for scripts/wt-new.mjs port-allocation + branch-name validation +
// .env.local rendering + install-step wiring, and for scripts/lib/branch-name.mjs.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBranchName } from '../lib/branch-name.mjs';
import {
  buildInstallCommands,
  computePorts,
  parseArgs,
  renderEnvLocal,
  renderLaunchBlock,
  renderServerEnv,
} from '../wt-new.mjs';
import { parseEnvLocal, parseWorktreePorcelain } from '../wt-list.mjs';

// ---- parseBranchName --------------------------------------------------------

const acceptedBranches = [
  ['feat/server-batch-retry', { type: 'feat', scope: 'server', slug: 'batch-retry' }],
  ['fix/frontend-voice-swatch-click', { type: 'fix', scope: 'frontend', slug: 'voice-swatch-click' }],
  ['refactor/sidecar-synth-pipeline', { type: 'refactor', scope: 'sidecar', slug: 'synth-pipeline' }],
  ['docs/docs-plan-38', { type: 'docs', scope: 'docs', slug: 'plan-38' }],
  ['chore/deps-bump-vitest', { type: 'chore', scope: 'deps', slug: 'bump-vitest' }],
  ['perf/server-cache-prompts', { type: 'perf', scope: 'server', slug: 'cache-prompts' }],
  ['test/e2e-sticky-generation', { type: 'test', scope: 'e2e', slug: 'sticky-generation' }],
  ['build/deps-bump-node', { type: 'build', scope: 'deps', slug: 'bump-node' }],
  ['ci/ci-pin-node-version', { type: 'ci', scope: 'ci', slug: 'pin-node-version' }],
];

for (const [branch, expected] of acceptedBranches) {
  test(`parseBranchName accepts ${branch}`, () => {
    const result = parseBranchName(branch);
    assert.equal(result.ok, true, `expected ok for ${branch}: ${JSON.stringify(result)}`);
    assert.equal(result.type, expected.type);
    assert.equal(result.scope, expected.scope);
    assert.equal(result.slug, expected.slug);
  });
}

const rejectedBranches = [
  '',
  'feat/server', // no slug
  'feat/server-', // slug is empty after dash
  'feat-server-thing', // no slash
  'wip/server-thing', // unknown type
  'feat/unknown-thing', // unknown scope
  'feat/Server-Caps', // uppercase
  'main',
  'feat/server-batch_retry', // underscore not allowed
  'feat//server-thing', // double slash
  null,
  undefined,
  123,
];

for (const branch of rejectedBranches) {
  test(`parseBranchName rejects ${JSON.stringify(branch)}`, () => {
    const result = parseBranchName(branch);
    assert.equal(result.ok, false, `expected reject for ${JSON.stringify(branch)}`);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  });
}

// ---- computePorts -----------------------------------------------------------

test('computePorts slot 0 yields stock ports (main worktree)', () => {
  const ports = computePorts(0);
  assert.equal(ports.VITE_PORT, 5173);
  assert.equal(ports.PORT, 8080);
  assert.equal(ports.VITE_API_PORT, 8080);
  assert.equal(ports.LOCAL_TTS_PORT, 9000);
  assert.equal(ports.PLAYWRIGHT_PORT, 5174);
});

test('computePorts slot 1 offsets every port by +10', () => {
  const ports = computePorts(1);
  assert.equal(ports.VITE_PORT, 5183);
  assert.equal(ports.PORT, 8090);
  assert.equal(ports.VITE_API_PORT, 8090);
  assert.equal(ports.LOCAL_TTS_PORT, 9010);
  assert.equal(ports.PLAYWRIGHT_PORT, 5184);
});

test('computePorts slot 2 offsets every port by +20', () => {
  const ports = computePorts(2);
  assert.equal(ports.VITE_PORT, 5193);
  assert.equal(ports.PORT, 8100);
  assert.equal(ports.LOCAL_TTS_PORT, 9020);
  assert.equal(ports.PLAYWRIGHT_PORT, 5194);
});

test('computePorts slot 9 offsets every port by +90', () => {
  const ports = computePorts(9);
  assert.equal(ports.VITE_PORT, 5263);
  assert.equal(ports.PORT, 8170);
  assert.equal(ports.LOCAL_TTS_PORT, 9090);
  assert.equal(ports.PLAYWRIGHT_PORT, 5264);
});

test('computePorts keeps VITE_API_PORT == PORT so the Vite proxy stays correct', () => {
  for (const slot of [0, 1, 2, 5, 9]) {
    const ports = computePorts(slot);
    assert.equal(
      ports.VITE_API_PORT,
      ports.PORT,
      `slot ${slot}: proxy target must match server port`,
    );
  }
});

test('computePorts rejects negative or non-integer slots', () => {
  assert.throws(() => computePorts(-1));
  assert.throws(() => computePorts(1.5));
  assert.throws(() => computePorts('1'));
  assert.throws(() => computePorts(null));
});

// ---- renderEnvLocal ---------------------------------------------------------

test('renderEnvLocal emits all five port variables', () => {
  const ports = computePorts(2);
  const env = renderEnvLocal({ slot: 2, branch: 'feat/server-foo', ports });
  for (const key of ['VITE_PORT', 'PORT', 'VITE_API_PORT', 'LOCAL_TTS_PORT', 'PLAYWRIGHT_PORT']) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `missing ${key}`);
  }
});

test('renderEnvLocal header names the source script and slot', () => {
  const env = renderEnvLocal({ slot: 3, branch: 'fix/frontend-x', ports: computePorts(3) });
  assert.match(env, /scripts\/wt-new\.mjs/);
  assert.match(env, /slot 3/);
  assert.match(env, /fix\/frontend-x/);
});

test('renderEnvLocal is round-trippable via parseEnvLocal', () => {
  const ports = computePorts(4);
  const env = renderEnvLocal({ slot: 4, branch: 'feat/server-bar', ports });
  const parsed = parseEnvLocal(env);
  assert.equal(parsed.VITE_PORT, String(ports.VITE_PORT));
  assert.equal(parsed.PORT, String(ports.PORT));
  assert.equal(parsed.LOCAL_TTS_PORT, String(ports.LOCAL_TTS_PORT));
  assert.equal(parsed.PLAYWRIGHT_PORT, String(ports.PLAYWRIGHT_PORT));
});

// ---- renderServerEnv (#2345 — server/.env isolation) ------------------------

test('renderServerEnv PORT matches renderEnvLocal PORT for the same slot (must not drift)', () => {
  for (const slot of [0, 1, 2, 5, 9]) {
    const ports = computePorts(slot);
    const envLocal = parseEnvLocal(renderEnvLocal({ slot, branch: 'feat/server-x', ports }));
    const serverEnv = parseEnvLocal(renderServerEnv({ slot, branch: 'feat/server-x', ports }));
    assert.equal(
      serverEnv.PORT,
      envLocal.PORT,
      `slot ${slot}: server/.env PORT must match .env.local PORT`,
    );
  }
});

test('renderServerEnv sets an isolated WORKSPACE_DIR (not the primary checkout, relative to server/)', () => {
  const ports = computePorts(1);
  const serverEnv = parseEnvLocal(renderServerEnv({ slot: 1, branch: 'feat/server-x', ports }));
  assert.ok(serverEnv.WORKSPACE_DIR, 'WORKSPACE_DIR must be set');
  // Relative (not absolute) — resolves against THIS worktree's own server/
  // per server/src/workspace/paths.ts, so it's isolated purely by virtue of
  // living inside this worktree, without hardcoding a disk path.
  assert.ok(
    !/^[A-Za-z]:[\\/]/.test(serverEnv.WORKSPACE_DIR) && !serverEnv.WORKSPACE_DIR.startsWith('/'),
    `WORKSPACE_DIR should be relative, got ${serverEnv.WORKSPACE_DIR}`,
  );
});

test('renderServerEnv still carries PORT and WORKSPACE_DIR', () => {
  const ports = computePorts(2);
  const serverEnv = parseEnvLocal(renderServerEnv({ slot: 2, branch: 'feat/server-x', ports }));
  assert.equal(serverEnv.PORT, String(ports.PORT));
  assert.ok(serverEnv.WORKSPACE_DIR, 'WORKSPACE_DIR must be set');
});

// #2632 fix: LOCAL_TTS_PORT MUST appear in the generated server/.env so both
// the server (spawn-sidecar.ts → resolveSidecarPort, getResolvedSidecarUrl)
// and sidecar (start.ps1/start.sh) read the same variable and coordinate on
// the same port. Before #2632, spawn-sidecar.ts and sidecar-owner.ts hardcoded
// :9000, and every request path hardcoded localhost:9000 — setting LOCAL_TTS_PORT
// here alone would have diverged them. Now both read it, so per-worktree isolation
// works and two worktrees never fight over :9000.
test('renderServerEnv sets LOCAL_TTS_PORT so server and sidecar coordinate on the per-worktree port (#2632)', () => {
  const ports = computePorts(1);
  const env = renderServerEnv({ slot: 1, branch: 'feat/server-x', ports });
  const parsed = parseEnvLocal(env);
  assert.equal(
    parsed.LOCAL_TTS_PORT,
    '9010',
    'server/.env must carry LOCAL_TTS_PORT matching the slot so spawn-sidecar and getResolvedSidecarUrl both probe/talk on the same per-worktree port (#2632)',
  );
  assert.match(env, /^LOCAL_TTS_PORT=9010$/m);
});

test('renderServerEnv never carries secret-shaped keys copied from a primary .env', () => {
  const ports = computePorts(0);
  const env = renderServerEnv({ slot: 0, branch: 'feat/server-x', ports });
  const parsed = parseEnvLocal(env);
  for (const secretKey of [
    'GEMINI_API_KEY',
    'OLLAMA_MODEL',
    'GEMINI_MODEL',
    'VOICE_STYLE_MODEL',
    'ANALYZER',
  ]) {
    assert.equal(parsed[secretKey], undefined, `${secretKey} must not appear in generated server/.env`);
  }
  // Belt-and-suspenders: no line is an ASSIGNMENT of a key containing
  // API_KEY (the header prose legitimately explains "no GEMINI_API_KEY" as
  // text — that's not a config line, so a bare substring match would be a
  // false positive; anchor to line-start so only a real `KEY=` counts).
  assert.doesNotMatch(env, /^[A-Z_]*API_KEY=/m);
});

test('renderServerEnv header names the source script and slot (matches renderEnvLocal convention)', () => {
  const env = renderServerEnv({ slot: 3, branch: 'fix/frontend-x', ports: computePorts(3) });
  assert.match(env, /scripts\/wt-new\.mjs/);
  assert.match(env, /slot 3/);
  assert.match(env, /fix\/frontend-x/);
});

test('renderLaunchBlock server port matches renderServerEnv PORT for the same slot', () => {
  for (const slot of [0, 1, 4]) {
    const ports = computePorts(slot);
    const serverEnv = parseEnvLocal(renderServerEnv({ slot, branch: 'feat/server-x', ports }));
    const block = renderLaunchBlock({
      worktreePath: 'C:/Claude/Projects/wt-foo',
      branch: 'feat/server-x',
      ports,
      slot,
      install: true,
    });
    assert.match(
      block,
      new RegExp(`server :${serverEnv.PORT}\\b`),
      `slot ${slot}: printed launch block server port must match generated server/.env PORT`,
    );
  }
});

// ---- parseWorktreePorcelain (consumed by wt-list) ---------------------------

test('parseWorktreePorcelain extracts path + branch for each worktree', () => {
  const sample = [
    'worktree C:/Claude/Projects/Audiobook-Generator',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree C:/Claude/Projects/wt-batch-retry',
    'HEAD def456',
    'branch refs/heads/feat/server-batch-retry',
    '',
  ].join('\n');
  const trees = parseWorktreePorcelain(sample);
  assert.equal(trees.length, 2);
  assert.equal(trees[0].path, 'C:/Claude/Projects/Audiobook-Generator');
  assert.equal(trees[0].branch, 'main');
  assert.equal(trees[1].path, 'C:/Claude/Projects/wt-batch-retry');
  assert.equal(trees[1].branch, 'feat/server-batch-retry');
});

test('parseWorktreePorcelain handles detached HEAD', () => {
  const sample = ['worktree C:/some/path', 'HEAD abc123', 'detached', ''].join('\n');
  const trees = parseWorktreePorcelain(sample);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].branch, '(detached)');
});

test('parseEnvLocal skips comments and blank lines', () => {
  const text = ['# header comment', '', 'VITE_PORT=5183', '   PORT=8090   ', '#PORT=999', ''].join(
    '\n',
  );
  const parsed = parseEnvLocal(text);
  assert.equal(parsed.VITE_PORT, '5183');
  assert.equal(parsed.PORT, '8090');
});

// ---- parseArgs (CLI flags) --------------------------------------------------

test('parseArgs defaults: install = true, from = main', () => {
  const args = parseArgs(['feat/server-foo']);
  assert.equal(args.branch, 'feat/server-foo');
  assert.equal(args.from, 'main');
  assert.equal(args.install, true);
});

test('parseArgs honours --no-install', () => {
  const args = parseArgs(['feat/server-foo', '--no-install']);
  assert.equal(args.branch, 'feat/server-foo');
  assert.equal(args.install, false);
});

test('parseArgs --no-install order-independent (flag before branch)', () => {
  const args = parseArgs(['--no-install', 'feat/server-foo']);
  assert.equal(args.branch, 'feat/server-foo');
  assert.equal(args.install, false);
});

test('parseArgs --from coexists with --no-install', () => {
  const args = parseArgs(['feat/server-foo', '--from', 'release/v2', '--no-install']);
  assert.equal(args.branch, 'feat/server-foo');
  assert.equal(args.from, 'release/v2');
  assert.equal(args.install, false);
});

test('parseArgs rejects unknown flags including typos like --noinstall', () => {
  assert.throws(() => parseArgs(['feat/server-foo', '--noinstall']));
  assert.throws(() => parseArgs(['feat/server-foo', '--bogus']));
});

// ---- buildInstallCommands ---------------------------------------------------

function makeTmpWorktree(layout = 'with-server') {
  const dir = mkdtempSync(join(tmpdir(), 'wt-new-test-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'castwright' }));
  if (layout === 'with-server') {
    mkdirSync(join(dir, 'server'));
    writeFileSync(join(dir, 'server', 'package.json'), JSON.stringify({ name: 'castwright-server' }));
  }
  return dir;
}

test('buildInstallCommands returns root + server when both package.json exist', () => {
  const dir = makeTmpWorktree('with-server');
  try {
    const cmds = buildInstallCommands(dir);
    assert.equal(cmds.length, 2);
    assert.deepEqual(cmds[0].args, ['install']);
    assert.equal(cmds[0].cwd, dir);
    assert.equal(cmds[0].label, 'root');
    assert.deepEqual(cmds[1].args, ['install', '--prefix', 'server']);
    assert.equal(cmds[1].cwd, dir);
    assert.equal(cmds[1].label, 'server');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildInstallCommands skips server when server/package.json is missing', () => {
  const dir = makeTmpWorktree('no-server');
  try {
    const cmds = buildInstallCommands(dir);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].label, 'root');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- renderLaunchBlock install-aware output ---------------------------------

test('renderLaunchBlock omits npm install when install=true (auto-installed)', () => {
  const block = renderLaunchBlock({
    worktreePath: 'C:/Claude/Projects/wt-foo',
    branch: 'feat/server-foo',
    ports: computePorts(1),
    slot: 1,
    install: true,
  });
  // Body of the launch block should not tell the user to run npm install again.
  assert.doesNotMatch(block, /^\s*npm install\b/m, 'auto-install mode should not print npm install lines');
  assert.match(block, /npm run dev/);
});

test('renderLaunchBlock reminds about the .venv AND voices/ junctions for sidecar/TTS work (#2811)', () => {
  const block = renderLaunchBlock({
    worktreePath: 'C:/Claude/Projects/wt-foo',
    branch: 'feat/server-foo',
    ports: computePorts(1),
    slot: 1,
    install: true,
  });
  assert.match(block, /server\/tts-sidecar\/\.venv/);
  assert.match(block, /server\/tts-sidecar\/voices\//);
});

test('renderLaunchBlock includes both npm install lines when install=false', () => {
  const block = renderLaunchBlock({
    worktreePath: 'C:/Claude/Projects/wt-foo',
    branch: 'feat/server-foo',
    ports: computePorts(1),
    slot: 1,
    install: false,
  });
  assert.match(block, /npm install\b.*husky hooks/);
  assert.match(block, /npm install --prefix server/);
});
