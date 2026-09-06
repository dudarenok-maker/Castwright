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
  extractSlotFromEnvLocal,
  findClaimedSlots,
  allocateNextSlot,
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


// ---- extractSlotFromEnvLocal ------------------------------------------------

test('extractSlotFromEnvLocal parses slot from header comment', () => {
  const env = renderEnvLocal({ slot: 2, branch: 'feat/server-foo', ports: computePorts(2) });
  assert.equal(extractSlotFromEnvLocal(env), 2);
});

test('extractSlotFromEnvLocal handles slot 0 (primary)', () => {
  const env = renderEnvLocal({ slot: 0, branch: 'main', ports: computePorts(0) });
  assert.equal(extractSlotFromEnvLocal(env), 0);
});

test('extractSlotFromEnvLocal handles multi-digit slot numbers', () => {
  const env = renderEnvLocal({ slot: 42, branch: 'feat/server-foo', ports: computePorts(42) });
  assert.equal(extractSlotFromEnvLocal(env), 42);
});

test('extractSlotFromEnvLocal returns null when the marker is absent', () => {
  assert.equal(extractSlotFromEnvLocal('# Some comment\nVITE_PORT=5173\n'), null);
});

test('extractSlotFromEnvLocal returns null for empty content', () => {
  assert.equal(extractSlotFromEnvLocal(''), null);
});

test('extractSlotFromEnvLocal only reads the first line, not a later marker', () => {
  // The generated marker is a first-line guarantee. A "worktree slot 9" phrase
  // appearing further down (e.g. a hand-added note) must not be mistaken for it.
  const env = 'VITE_PORT=5173\n# note: this pairs with worktree slot 9\n';
  assert.equal(extractSlotFromEnvLocal(env), null);
});

test('extractSlotFromEnvLocal round-trips every slot renderEnvLocal writes', () => {
  for (const slot of [0, 1, 5, 20]) {
    const env = renderEnvLocal({ slot, branch: 'feat/server-test', ports: computePorts(slot) });
    assert.equal(extractSlotFromEnvLocal(env), slot, `round-trip failed for slot ${slot}`);
  }
});

// ---- findClaimedSlots -------------------------------------------------------

// Builds a fixture directory holding one subdirectory per fake worktree, and
// returns their absolute paths in the order given. A `slot` of null means the
// tree exists but has no .env.local at all (an EnterWorktree-made tree); a
// string value is written verbatim as the file's contents.
function makeWorktreeFixture(t, specs) {
  const root = mkdtempSync(join(tmpdir(), 'wt-slots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return specs.map((spec, i) => {
    const treePath = join(root, `tree-${i}`);
    mkdirSync(treePath, { recursive: true });
    if (spec === null) return treePath;
    const contents =
      typeof spec === 'string'
        ? spec
        : renderEnvLocal({ slot: spec, branch: `feat/server-t${i}`, ports: computePorts(spec) });
    writeFileSync(join(treePath, '.env.local'), contents, 'utf8');
    return treePath;
  });
}

test('findClaimedSlots reads the slot each worktree .env.local claims', (t) => {
  const paths = makeWorktreeFixture(t, [0, 3, 1]);
  assert.deepEqual(findClaimedSlots(paths), [0, 1, 3]);
});

test('findClaimedSlots returns an empty list when there are no worktrees', (t) => {
  makeWorktreeFixture(t, []);
  assert.deepEqual(findClaimedSlots([]), []);
});

test('findClaimedSlots ignores a worktree with no .env.local (claims no slot)', (t) => {
  // #3052: EnterWorktree / Agent isolation:"worktree" trees never write
  // .env.local. Such a tree must claim nothing and must not block allocation.
  const paths = makeWorktreeFixture(t, [null, 2, null]);
  assert.deepEqual(findClaimedSlots(paths), [2]);
  assert.equal(allocateNextSlot(findClaimedSlots(paths)), 1);
});

test('findClaimedSlots skips an .env.local with no slot marker', (t) => {
  const paths = makeWorktreeFixture(t, ['# hand-written\nVITE_PORT=5173\n', 4]);
  assert.deepEqual(findClaimedSlots(paths), [4]);
});

test('findClaimedSlots de-duplicates two worktrees claiming the same slot', (t) => {
  // The #3052 collision state itself: two live trees both stamped slot 2.
  const paths = makeWorktreeFixture(t, [2, 2, 5]);
  assert.deepEqual(findClaimedSlots(paths), [2, 5]);
});

// ---- allocateNextSlot -------------------------------------------------------

test('allocateNextSlot returns 1 when no slots are claimed', () => {
  assert.equal(allocateNextSlot([]), 1);
});

test('allocateNextSlot fills the lowest gap: claimed [1,3,4] -> 2', () => {
  assert.equal(allocateNextSlot([1, 3, 4]), 2);
});

test('allocateNextSlot returns next after a contiguous run: claimed [1,2,3] -> 4', () => {
  assert.equal(allocateNextSlot([1, 2, 3]), 4);
});

test('allocateNextSlot never hands out slot 0, reserved for the primary checkout', () => {
  // Slot 0 belongs to the primary checkout, so allocation starts at 1 whether
  // or not a tree has stamped slot 0 — including when nothing is claimed and
  // when the first claim already sits above the floor.
  for (const claimed of [[], [0], [0, 1], [1, 3], [0, 2, 3], [4]]) {
    const got = allocateNextSlot(claimed);
    assert.ok(got >= 1, `allocateNextSlot(${JSON.stringify(claimed)}) returned ${got}, below the floor`);
  }
  assert.equal(allocateNextSlot([0]), 1);
  assert.equal(allocateNextSlot([0, 1]), 2);
});

test('allocateNextSlot returns the first gap in a sparse claim: [1,2,5,10] -> 3', () => {
  assert.equal(allocateNextSlot([1, 2, 5, 10]), 3);
});

test('allocateNextSlot never returns a slot that is already claimed', () => {
  const claimedSets = [[], [1], [0, 1], [1, 3, 4], [1, 2, 5, 10], [2, 3], [0, 2, 3, 7]];
  for (const claimed of claimedSets) {
    const got = allocateNextSlot(claimed);
    assert.ok(got >= 1, `slot ${got} for claimed ${JSON.stringify(claimed)} must be >= 1`);
    assert.ok(
      !claimed.includes(got),
      `allocateNextSlot(${JSON.stringify(claimed)}) returned already-claimed slot ${got}`,
    );
  }
});

// The #3052 regression. Old behaviour allocated `slot = <number of worktrees>`.
// Fixture: five trees were created at slots 0..4, then slots 1 and 2 were torn
// down. Three trees survive (0, 3, 4), so the old count-based rule hands the
// next tree slot 3 — colliding head-on with the surviving tree already on 3.
// The fix allocates the lowest unclaimed slot, 1.
test('allocateNextSlot does not re-issue a surviving worktree slot after teardown (#3052)', (t) => {
  const paths = makeWorktreeFixture(t, [0, 3, 4]);
  const claimed = findClaimedSlots(paths);
  assert.deepEqual(claimed, [0, 3, 4]);

  const allocated = allocateNextSlot(claimed);

  // Passes only under the fix; the old count-based rule yields paths.length === 3.
  assert.equal(allocated, 1, 'expected the lowest free slot');
  assert.notEqual(
    allocated,
    paths.length,
    `old count-based allocation would have returned ${paths.length}, colliding with a live tree`,
  );
  assert.ok(!claimed.includes(allocated), 'allocated slot collides with a live worktree');

  // And the collision the old rule caused is a real port clash, not just a
  // number clash: slot 3 reuses the surviving tree's ports exactly.
  assert.deepEqual(computePorts(paths.length), computePorts(3));
  assert.notDeepEqual(computePorts(allocated), computePorts(3));
});
