// fs-1 — pin restart-after-upgrade's waitForExit polling.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPGRADE_STATE_PATH, runRestart, waitForExit } from '../restart-after-upgrade.mjs';

const noSleep = async () => {};

test('resolves true as soon as the pid is gone', async () => {
  let calls = 0;
  // alive for the first 2 polls, then exits.
  const isAlive = () => {
    calls += 1;
    return calls < 3;
  };
  const exited = await waitForExit({ pid: 123, timeoutMs: 10000, intervalMs: 1, isAlive, sleep: noSleep });
  assert.equal(exited, true);
});

test('resolves true immediately when the pid is already gone', async () => {
  const exited = await waitForExit({ pid: 123, isAlive: () => false, sleep: noSleep });
  assert.equal(exited, true);
});

test('resolves false on timeout when the pid never exits', async () => {
  // Injected clock advances past the deadline after a couple of polls.
  let t = 0;
  const now = () => (t += 400); // deadline = first now() + 1000
  const exited = await waitForExit({
    pid: 123,
    timeoutMs: 1000,
    intervalMs: 1,
    isAlive: () => true,
    sleep: noSleep,
    now,
  });
  assert.equal(exited, false);
});

// #4443 owner decision (b): the restarter runs the Node runtime guard against
// the NEW release before it launches. On a would-refuse Node it points
// .current-version back at the previous release, relaunches THAT, and leaves
// the reason in the upgrade state file the app's /api/upgrade/state serves.

const AFFECTED = 'v24.15.0';
const FIXED = 'v24.22.3';

// A complete release: its launch entry and a package.json. `ranges` is that
// release's OWN crash-range list (omitted = a pre-guard release, which starts).
function fakeRelease(root, name, ranges) {
  const dir = join(root, 'releases', name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'start-app-prod.mjs'), '');
  const pkg = ranges ? { castwright: { node: { windowsLoopbackCrash: ranges } } } : {};
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
}

const GUARD_RANGES = [{ from: '24.0.0', toExclusive: '24.16.0' }];

function fakeInstall(pointer = '1.16.0', releases = ['v1.15.0', 'v1.16.0']) {
  const root = mkdtempSync(join(tmpdir(), 'castwright-restart-'));
  for (const r of releases) fakeRelease(root, r);
  writeFileSync(join(root, '.current-version'), pointer);
  return root;
}

function drive(root, { version, platform = 'win32', env = {}, ...rest }) {
  const launched = [];
  const out = [];
  return runRestart({
    env: { UPGRADE_INSTALL_ROOT: root, ...env },
    version,
    platform,
    execPath: 'C:/Program Files/nodejs/node.exe',
    wait: async () => true,
    spawnLauncher: (opts) => launched.push({ ...opts, pointer: readFileSync(join(root, '.current-version'), 'utf8') }),
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(t),
    ...rest,
  }).then((result) => ({ result, launched, out }));
}

const readState = (root) => JSON.parse(readFileSync(join(root, '.upgrade-staging', 'state.json'), 'utf8'));

test('would-refuse: pointer goes back, the previous release is relaunched, the reason is surfaced', async () => {
  const root = fakeInstall();
  try {
    const { result, launched } = await drive(root, { version: AFFECTED });
    assert.equal(result.action, 'rolled-back');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.15.0');
    assert.equal(launched.length, 1, 'the launcher runs exactly once');
    assert.equal(launched[0].pointer, '1.15.0', 'launch.mjs reads the PREVIOUS release');
    const state = readState(root);
    assert.equal(state.phase, 'error');
    assert.equal(state.candidateVersion, '1.16.0');
    for (const text of [state.error, state.errorLan]) {
      assert.match(text, /Upgrade to v1\.16\.0 was held back/);
      assert.match(text, /still running v1\.15\.0/);
      assert.match(text, /Node v24\.15\.0/);
      assert.match(text, /Install Node v24\.16\.0 or newer/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('passes: the pointer stays on the new release, it launches, no error is recorded', async () => {
  const root = fakeInstall();
  try {
    const { result, launched } = await drive(root, { version: FIXED });
    assert.equal(result.action, 'proceed');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.16.0');
    assert.equal(launched.length, 1);
    assert.equal(launched[0].pointer, '1.16.0');
    assert.equal(existsSync(join(root, '.upgrade-staging', 'state.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an affected Node off Windows is not held back', async () => {
  const root = fakeInstall();
  try {
    const { result } = await drive(root, { version: AFFECTED, platform: 'linux' });
    assert.equal(result.action, 'proceed');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.16.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the guard check itself failing fails safe to the previous release', async () => {
  const root = fakeInstall();
  try {
    const { result, launched } = await drive(root, {
      version: FIXED,
      loadRanges: () => {
        throw new Error('package.json unreadable');
      },
    });
    assert.equal(result.action, 'rolled-back');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.15.0');
    assert.equal(launched[0].pointer, '1.15.0');
    assert.match(readState(root).error, /could not check that your Node can run it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with no previous release to fall back to it still launches, never leaving nothing running', async () => {
  const root = fakeInstall('1.16.0', ['v1.16.0']);
  try {
    const { result, launched } = await drive(root, { version: AFFECTED });
    assert.equal(result.action, 'no-fallback');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.16.0');
    assert.equal(launched.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the previous release is the highest OTHER release below the new one, numerically', async () => {
  const root = fakeInstall('1.16.0', ['v1.9.0', 'v1.15.0', 'v1.16.0', 'v1.17.0', 'v1.15.0-old']);
  try {
    await drive(root, { version: AFFECTED });
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.15.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a held-back release left on disk is never the rollback target of the next upgrade (P4-1)', async () => {
  const root = fakeInstall('1.16.1', ['v1.15.0']);
  fakeRelease(root, 'v1.16.0', GUARD_RANGES);
  fakeRelease(root, 'v1.16.1', GUARD_RANGES);
  try {
    const { result, launched } = await drive(root, { version: AFFECTED });
    assert.equal(result.action, 'rolled-back');
    assert.equal(result.to, '1.15.0', 'v1.16.0 carries the guard and would refuse this Node too');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.15.0');
    assert.equal(launched[0].pointer, '1.15.0');
    assert.match(readState(root).error, /still running v1\.15\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a partial release dir from a failed apply is skipped as a rollback target (P4-1)', async () => {
  const root = fakeInstall('1.16.1', ['v1.15.0']);
  mkdirSync(join(root, 'releases', 'v1.16.0', 'scripts'), { recursive: true }); // no start-app-prod.mjs
  writeFileSync(join(root, 'releases', 'v1.16.0', 'package.json'), '{}');
  mkdirSync(join(root, 'releases', 'v1.16.0b'), { recursive: true });
  fakeRelease(root, 'v1.16.1', GUARD_RANGES);
  try {
    const { result } = await drive(root, { version: AFFECTED });
    assert.equal(result.to, '1.15.0');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.15.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no runnable release below: no-fallback, the pointer and the state file are left alone (P4-1)', async () => {
  const root = fakeInstall('1.16.1', []);
  fakeRelease(root, 'v1.16.0', GUARD_RANGES);
  fakeRelease(root, 'v1.16.1', GUARD_RANGES);
  try {
    const { result, launched } = await drive(root, { version: AFFECTED });
    assert.equal(result.action, 'no-fallback');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.16.1');
    assert.equal(existsSync(join(root, '.upgrade-staging', 'state.json')), false, 'never claims a release that will not run is running');
    assert.equal(launched.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the state file path matches the one the server reads (server/src/upgrade/paths.ts)', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'src', 'upgrade', 'paths.ts'), 'utf8');
  assert.ok(src.includes(`stagingDir = join(installRoot, '${UPGRADE_STATE_PATH[0]}')`));
  assert.ok(src.includes(`stateFile: join(stagingDir, '${UPGRADE_STATE_PATH[1]}')`));
});
