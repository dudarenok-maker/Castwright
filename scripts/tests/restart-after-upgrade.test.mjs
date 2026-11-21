// fs-1 — pin restart-after-upgrade's waitForExit polling.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPGRADE_RESTART_LOG, UPGRADE_STATE_PATH, runRestart, waitForExit } from '../restart-after-upgrade.mjs';

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

// A complete release: its launch entry, a package.json and both finished npm installs. `ranges` is that
// release's OWN crash-range list (omitted = a pre-guard release, which starts).
function fakeRelease(root, name, ranges) {
  const dir = join(root, 'releases', name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'start-app-prod.mjs'), '');
  for (const d of [dir, join(dir, 'server')]) {
    mkdirSync(join(d, 'node_modules'), { recursive: true });
    writeFileSync(join(d, 'node_modules', '.package-lock.json'), '{}');
  }
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
    assert.match(readState(root).error, /could not check that your Node can run the new release/);
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

test('an unwritable state file still relaunches, with the rollback in place (P4-2)', async () => {
  const root = fakeInstall();
  mkdirSync(join(root, '.upgrade-staging', 'state.json'), { recursive: true }); // EISDIR on write
  try {
    const { result, launched, out } = await drive(root, { version: AFFECTED });
    assert.equal(result.action, 'rolled-back');
    assert.equal(launched.length, 1);
    assert.equal(launched[0].pointer, '1.15.0');
    assert.match(out.join(''), /could not record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pointer write failure still relaunches whatever the pointer names (P4-2)', async () => {
  const root = fakeInstall();
  mkdirSync(join(root, '.current-version.tmp'), { recursive: true }); // the temp write throws EISDIR
  try {
    const { launched, out } = await drive(root, { version: AFFECTED });
    assert.equal(launched.length, 1);
    assert.equal(launched[0].pointer, '1.16.0');
    assert.match(out.join(''), /could not switch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runRestart spawns the launcher even if the guard itself throws (P4-2)', async () => {
  const root = fakeInstall();
  try {
    let called = 0;
    const { launched } = await drive(root, {
      version: AFFECTED,
      guard: () => {
        called += 1;
        throw new Error('boom');
      },
    });
    assert.equal(called, 1, 'the injected guard ran');
    assert.equal(launched.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('neither pointer writer deletes .current-version before the rename (P4-2)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [['..', 'restart-after-upgrade.mjs'], ['..', '..', 'server', 'src', 'upgrade', 'apply.ts']]) {
    const src = readFileSync(resolve(here, ...rel), 'utf8');
    assert.ok(src.includes('renameSync(tmp, pointer)'), `${rel.at(-1)} still renames over the pointer`);
    assert.doesNotMatch(src, /rmSync\(pointer/, `${rel.at(-1)} must not delete the pointer first`);
  }
});

test('off Windows a failing check is not a hold-back and never loads the lists (P4-3)', async () => {
  const root = fakeInstall();
  try {
    const { result } = await drive(root, {
      version: AFFECTED,
      platform: 'linux',
      loadRanges: () => {
        throw new Error('must not be called');
      },
    });
    assert.equal(result.action, 'proceed');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.16.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed check stores a fixed path-free sentence, the raw message only goes to the log (P4-3)', async () => {
  const root = fakeInstall();
  const raw = "ENOENT: no such file or directory, open 'C:\\Users\\someone\\releases\\v1.16.0\\package.json'";
  try {
    const { out } = await drive(root, {
      version: FIXED,
      loadRanges: () => {
        throw new Error(raw);
      },
    });
    const state = readState(root);
    for (const text of [state.error, state.errorLan]) {
      assert.doesNotMatch(text, /someone|ENOENT|package\.json/);
      assert.match(text, /Castwright could not check that your Node can run the new release\./);
    }
    assert.match(out.join(''), /someone/, 'the raw detail is still logged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the state file path matches the one the server reads (server/src/upgrade/paths.ts)', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'src', 'upgrade', 'paths.ts'), 'utf8');
  assert.ok(src.includes(`stagingDir = join(installRoot, '${UPGRADE_STATE_PATH[0]}')`));
  assert.ok(src.includes(`stateFile: join(stagingDir, '${UPGRADE_STATE_PATH[1]}')`));
});

test('a read-only .current-version is still switched back (P5-1)', async () => {
  const root = fakeInstall();
  chmodSync(join(root, '.current-version'), 0o444); // EPERM on win32 for a bare rename over it
  try {
    const { result, launched } = await drive(root, { version: AFFECTED });
    assert.equal(result.action, 'rolled-back');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.15.0');
    assert.equal(launched[0].pointer, '1.15.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a release whose npm ci never finished is skipped as a rollback target (P5-2)', async () => {
  const root = fakeInstall('1.16.1', ['v1.14.0']);
  fakeRelease(root, 'v1.16.1', GUARD_RANGES);
  fakeRelease(root, 'v1.15.0');
  rmSync(join(root, 'releases', 'v1.15.0', 'server', 'node_modules'), { recursive: true }); // root installed, server/ not
  fakeRelease(root, 'v1.15.5');
  rmSync(join(root, 'releases', 'v1.15.5', 'node_modules'), { recursive: true }); // nothing installed
  try {
    const { result } = await drive(root, { version: AFFECTED });
    assert.equal(result.to, '1.14.0');
    assert.equal(readFileSync(join(root, '.current-version'), 'utf8'), '1.14.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a release with an unreadable package.json is skipped (P5-3)', async () => {
  const root = fakeInstall('1.16.1', ['v1.14.0']);
  fakeRelease(root, 'v1.16.1', GUARD_RANGES);
  fakeRelease(root, 'v1.15.0');
  writeFileSync(join(root, 'releases', 'v1.15.0', 'package.json'), '{ not json');
  try {
    const { result } = await drive(root, { version: AFFECTED });
    assert.equal(result.to, '1.14.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a release whose crash-range list is not an array is skipped (P5-3)', async () => {
  const root = fakeInstall('1.16.1', ['v1.14.0']);
  fakeRelease(root, 'v1.16.1', GUARD_RANGES);
  fakeRelease(root, 'v1.15.0', { from: '24.0.0', toExclusive: '24.16.0' });
  try {
    const { result } = await drive(root, { version: AFFECTED });
    assert.equal(result.to, '1.14.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failure lines are appended to upgrade-restart.log in APP_LOG_DIR as well as stderr (P5-4)', async () => {
  const root = fakeInstall();
  const logDir = mkdtempSync(join(tmpdir(), 'castwright-restart-logs-'));
  try {
    const { launched, out } = await drive(root, {
      version: AFFECTED,
      env: { APP_LOG_DIR: logDir },
      guard: () => {
        throw new Error('boom');
      },
    });
    const logged = readFileSync(join(logDir, UPGRADE_RESTART_LOG), 'utf8');
    assert.match(logged, /the Node check failed, launching anyway: boom/);
    assert.match(out.join(''), /boom/, 'stderr still gets it');
    assert.equal(launched.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('the guard log lines (failed pointer write) reach the file too, default <install>/logs (P5-4)', async () => {
  const root = fakeInstall();
  mkdirSync(join(root, '.current-version.tmp'), { recursive: true });
  try {
    await drive(root, { version: AFFECTED });
    assert.match(readFileSync(join(root, 'logs', UPGRADE_RESTART_LOG), 'utf8'), /could not switch back to v1\.15\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unwritable log never stops the relaunch (P5-4)', async () => {
  const root = fakeInstall();
  writeFileSync(join(root, 'logs'), 'a file where the log dir should be'); // mkdir / append throw
  try {
    const { launched } = await drive(root, {
      version: AFFECTED,
      guard: () => {
        throw new Error('boom');
      },
    });
    assert.equal(launched.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
