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

function fakeInstall(pointer = '1.16.0', releases = ['v1.15.0', 'v1.16.0']) {
  const root = mkdtempSync(join(tmpdir(), 'castwright-restart-'));
  for (const r of releases) mkdirSync(join(root, 'releases', r), { recursive: true });
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

test('the state file path matches the one the server reads (server/src/upgrade/paths.ts)', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'src', 'upgrade', 'paths.ts'), 'utf8');
  assert.ok(src.includes(`stagingDir = join(installRoot, '${UPGRADE_STATE_PATH[0]}')`));
  assert.ok(src.includes(`stateFile: join(stagingDir, '${UPGRADE_STATE_PATH[1]}')`));
});
