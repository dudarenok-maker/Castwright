// runStepProcess against real `npm run` child processes: attempt counting,
// budget/timeout classification, and the #3695 timeout re-sweep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  runStepProcess,
  _internals,
} from '../verify-cache.mjs';
import {
  HANG_FIXTURE_SELF_EXIT_MS,
  STEP_BUDGET_PAST_LAUNCH_MS,
  armSurvivorWatch,
  assertHangFixtureKilled,
  mkTmp,
  pidAlive,
  readHangPid,
  writeFlakyFixture,
  writeHangingFixture,
} from './verify-cache-test-support.mjs';


// Resolve relative to THIS file, not the process cwd — same rationale as
// scripts/tests/run-golden-audio.test.mjs's own HERE/SRC_PATH.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, '..', 'verify-cache.mjs');
const src = readFileSync(SRC_PATH, 'utf8');

test('runStepProcess keys the retriable-pool-crash lookup on retryKey, not the spawned npm script', () => {
  const match = src.match(/function runStepProcess\([\s\S]*?\n\}/);
  assert.ok(match, "could not locate runStepProcess's function body in verify-cache.mjs");
  const body = match[0];
  assert.match(
    body,
    /RETRIABLE_POOL_STEPS\.has\(retryKey\)/,
    'runStepProcess must check RETRIABLE_POOL_STEPS against retryKey (the original step name, e.g. ' +
      "\"test:server\"), not the substituted --changed npm script (\"test:server:changed\") — " +
      'otherwise a --scope-staged run never retries a fork-pool crash',
  );
  assert.match(
    body,
    /spawn\('npm', \['run', npmScript\]/,
    'runStepProcess must spawn npmScript (the possibly-substituted script), not retryKey',
  );
});


// --- Attempt-count propagation (#3018) -----------------------------------
//
// Unlike the CHANGED_ONLY_NPM_SCRIPT/runStepProcess wiring test above (which
// pins the retryKey-vs-npmScript distinction by source regex to avoid
// spawning real vitest), these tests need to observe runStepProcess's actual
// return value across real retries — that can't be proven by reading source.
// So they spawn a real npm process, but only ever against a throwaway
// package.json whose "script" is a one-line node invocation of a local
// fixture file — milliseconds, not a vitest battery.


test('runStepProcess: a step passing on the first attempt records 1 attempt', async () => {
  const dir = mkTmp();
  writeFlakyFixture(dir, 'always-pass', { failFirst: false });
  const result = await runStepProcess('always-pass', { cwd: dir, env: process.env, retryKey: 'test:server' });
  assert.equal(result.code, 0);
  assert.equal(result.attempts, 1);
});


test('runStepProcess: a fork-pool crash followed by a pass records the true attempt count, summed across attempts', async () => {
  const dir = mkTmp();
  const marker = writeFlakyFixture(dir, 'flaky', { failFirst: true });
  const result = await runStepProcess('flaky', { cwd: dir, env: process.env, retryKey: 'test:server' });
  assert.equal(result.code, 0);
  assert.equal(result.attempts, 2, 'first attempt crashes, second passes — 2 total attempts');
  // The fixture appends to marker on each launch, so 2 attempts → 2 bytes.
  assert.equal(readFileSync(marker, 'utf8').length, 2, 'marker file must record 2 real process launches');
});


test('runStepProcess: a non-retriable step always records 1 attempt, even given a crash-shaped failure', async () => {
  const dir = mkTmp();
  writeFlakyFixture(dir, 'flaky-nonretriable', { failFirst: true });
  // retryKey NOT in RETRIABLE_POOL_STEPS — must never retry, regardless of
  // stderr shape, and must report exactly 1 attempt.
  const result = await runStepProcess('flaky-nonretriable', {
    cwd: dir,
    env: process.env,
    retryKey: 'some-other-step',
  });
  assert.equal(result.code, 1);
  assert.equal(result.attempts, 1);
});


// --- Part 2 (ops-72) time budgets ----------------------------------------


test('readHangPid: only a positive integer pid is returned; empty / 0 / garbled / negative content is null', () => {
  const dir = mkTmp();
  assert.equal(readHangPid(dir), null, 'absent file');
  for (const content of ['', '0', 'abc', '-5', '1.5', '  ']) {
    writeFileSync(join(dir, 'hang.pid'), content, 'utf8');
    assert.equal(readHangPid(dir), null, `content ${JSON.stringify(content)}`);
  }
  writeFileSync(join(dir, 'hang.pid'), '12345', 'utf8');
  assert.equal(readHangPid(dir), 12345);
});


test('runStepProcess: a step exceeding its budget is classified TIMEOUT, not a crash-retry exhaustion (mutation test)', async () => {
  const dir = mkTmp();
  writeHangingFixture(dir, 'hang');
  const watch = armSurvivorWatch(dir);
  const start = Date.now();
  // retryKey IS in RETRIABLE_POOL_STEPS on purpose — this is exactly the
  // shape that could be mistaken for a crash-retry exhaustion (attempts ===
  // MAX_POOL_ATTEMPTS) if the timeout classification were folded into, or
  // ordered after, the isVitestPoolCrash check instead of short-circuiting
  // before it.
  // The finally disarms the survivor watch (clearTimeout only — its recorded
  // verdict stays readable) on every exit, so a throwing call or a failing
  // assertion neither holds the file open nor SIGKILLs a reused pid later.
  try {
    const result = await runStepProcess('hang', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      timeoutMs: STEP_BUDGET_PAST_LAUNCH_MS,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.timedOut, true, 'a wedged process must be classified as a timeout');
    assert.notEqual(result.code, 0);
    assert.equal(
      result.attempts,
      1,
      'a timed-out attempt must never be retried as a vitest pool crash — attempts must stay at 1, ' +
        'not climb to MAX_POOL_ATTEMPTS (3) the way a real fork-pool crash would',
    );
    assertHangFixtureKilled(dir, elapsed, watch);
  } finally {
    watch.disarm();
  }
});


// #3695: timeout re-sweep. DI tests drive runStepProcess with a kill that
// misses a descendant (so 'close' never fires) and a fake process snapshot, so
// the sweep logic is tested without a real race. The real-process Windows test
// below proves the same against a genuine survivor.
const RESWEEP_TEST_GRACE_MS = 100;
const NO_CENSUS = () => {};
// A fixture step plus the harness shared by the DI tests: `killTreeFn` captures
// the child (to clean it up) and does nothing else, i.e. the kill missed.
function resweepHarness(dir) {
  writeHangingFixture(dir, 'hang');
  const h = { child: null, logs: [], swept: [] };
  h.killTreeFn = (child) => {
    h.child = child;
  };
  h.logFn = (m) => h.logs.push(m);
  h.cleanup = () => {
    if (h.child) _internals.killStepChildTree(h.child);
    const pid = readHangPid(dir);
    if (pid !== null && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  };
  return h;
}


test('runStepProcess re-sweep: a descendant the first kill missed is found and killed, the step settles as a timeout (#3695)', async () => {
  const dir = mkTmp();
  const h = resweepHarness(dir);
  const SURVIVOR = 987654321;
  const T = Date.now() + 100; // the step root started just after the test began
  // Pre-kill snapshot: root only. Re-sweep snapshot: root's tree PLUS a late
  // child (spawned after the kill's snapshot) hanging off the root pid.
  let calls = 0;
  const snapshotFn = () => {
    calls += 1;
    const rows = [{ pid: h.child?.pid ?? process.pid + 1, ppid: 1, name: 'x', commandLine: '', cpuSeconds: 0, startedAt: T }];
    if (calls > 1) rows.push({ pid: SURVIVOR, ppid: rows[0].pid, name: 'y', commandLine: '', cpuSeconds: 0, startedAt: T + 1 });
    return rows;
  };
  const start = Date.now();
  try {
    const result = await runStepProcess('hang', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      timeoutMs: 1500,
      killTreeFn: h.killTreeFn,
      snapshotFn,
      censusFn: NO_CENSUS,
      logFn: h.logFn,
      windows: true,
      resweepGraceMs: RESWEEP_TEST_GRACE_MS,
      sweepKillFn: (pid) => {
        h.swept.push(pid);
        // Killing the late child "releases the pipe": really kill the tree.
        if (pid === SURVIVOR) _internals.killStepChildTree(h.child);
      },
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.attempts, 1);
    assert.ok(h.swept.includes(SURVIVOR), `the re-sweep must kill the late descendant; swept ${JSON.stringify(h.swept)}`);
    assert.ok(Date.now() - start < 1500 + 5_000, 'must settle promptly after the sweep, not wait for the fixture');
    assert.equal(h.logs.length, 0, 'a successful sweep settles on close, with no give-up line');
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: survivors that never die => bounded sweeps, then settles as a timeout and names the pids (#3695)', async () => {
  const dir = mkTmp();
  const h = resweepHarness(dir);
  let sweeps = 0;
  const T = Date.now() + 100;
  const snapshotFn = () => [
    { pid: h.child?.pid ?? 1, ppid: 1, name: 'x', commandLine: '', cpuSeconds: 0, startedAt: T },
  ];
  const start = Date.now();
  try {
    const result = await runStepProcess('hang', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      timeoutMs: 1500,
      killTreeFn: h.killTreeFn,
      snapshotFn,
      censusFn: NO_CENSUS,
      logFn: h.logFn,
      windows: true,
      resweepGraceMs: RESWEEP_TEST_GRACE_MS,
      resweepMax: 2,
      sweepKillFn: () => {
        sweeps += 1; // the kill "fails": the root stays alive and holds the pipe
      },
    });
    assert.equal(result.timedOut, true);
    assert.equal(sweeps, 2, 'exactly resweepMax sweeps, each targeting the live root');
    assert.ok(Date.now() - start < 1500 + 5_000, 'must settle within budget + a few graces, not at the fixture self-exit');
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0], /\[timeout\] hang: 'close' not seen after the kill and 2 re-sweep\(s\)/);
    assert.match(h.logs[0], new RegExp(`${h.child.pid}`), 'names the surviving pid');
    assert.equal(h.child.stderr.destroyed, true, "give-up must destroy the piped stderr so a surviving holder can't keep the process open");
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: never targets pid 0, this process or its ancestors (#3695)', async () => {
  const dir = mkTmp();
  const h = resweepHarness(dir);
  const swept = [];
  const T = Date.now() + 100;
  try {
    await runStepProcess('hang', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      timeoutMs: 1000,
      killTreeFn: h.killTreeFn,
      // A snapshot that makes this process and a parent hang off the step root.
      snapshotFn: (root) => {
        return [
          { pid: root, ppid: 1, name: 'r', commandLine: '', cpuSeconds: 0, startedAt: T },
          { pid: 0, ppid: root, name: 'z', commandLine: '', cpuSeconds: 0, startedAt: T },
          { pid: process.pid, ppid: root, name: 'me', commandLine: '', cpuSeconds: 0, startedAt: T },
          { pid: 2147480002, ppid: root, name: 'ok', commandLine: '', cpuSeconds: 0, startedAt: T },
        ];
      },
      censusFn: NO_CENSUS,
      logFn: h.logFn,
      windows: true,
      resweepGraceMs: RESWEEP_TEST_GRACE_MS,
      resweepMax: 1,
      sweepKillFn: (pid) => swept.push(pid),
    });
    assert.ok(!swept.includes(0) && !swept.includes(process.pid), `protected pids swept: ${JSON.stringify(swept)}`);
    // The root is an "ancestor" of this process in the fake snapshot (process.pid
    // hangs off it), so the ancestry guard must keep it out of the sweep too.
    assert.ok(!swept.includes(h.child.pid), `an ancestor of this process (the step root) must not be swept: ${JSON.stringify(swept)}`);
    assert.ok(swept.includes(2147480002), 'an ordinary descendant is still a target');
  } finally {
    h.cleanup();
  }
});


// Start-time-aware walk (#3695 review): on Windows an orphan keeps its dead
// parent's pid as ParentProcessId, so once that number is recycled an unrelated
// process reads as a "child" of a recorded pid. `taskkill /T` refuses such an
// edge (child older than parent); the re-sweep must too.
function resweepStaleHarness(dir, { preKill, reSweep }) {
  const h = resweepHarness(dir);
  let calls = 0;
  h.snapshotFn = (root) => {
    calls += 1;
    const rows = calls === 1 ? preKill(root) : reSweep(root);
    if (rows === null) throw new Error('snapshot failed');
    return rows;
  };
  h.run = (extra = {}) =>
    runStepProcess('hang', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      timeoutMs: 1000,
      killTreeFn: h.killTreeFn,
      snapshotFn: h.snapshotFn,
      censusFn: NO_CENSUS,
      logFn: h.logFn,
      windows: true,
      resweepGraceMs: RESWEEP_TEST_GRACE_MS,
      resweepMax: 1,
      sweepKillFn: (pid) => h.swept.push(pid),
      ...extra,
    });
  return h;
}

const row = (pid, ppid, startedAt) => ({ pid, ppid, name: 'p', commandLine: '', cpuSeconds: 0, startedAt });


test('runStepProcess re-sweep: a stale-ppid process older than its parent is not followed, a genuine later child is (#3695)', async () => {
  const dir = mkTmp();
  const LATE = 2147480010;
  const STALE = 2147480011; // names LATE's pid but started BEFORE LATE: not its child
  const KID = 2147480012; // genuine child of LATE
  // The root's recorded start is spawnedAt (approx, empty pre-kill snapshot), so every row that must
  // postdate the spawn is stamped from a time taken AFTER it, however slow setup was (#4005).
  // Valid only because runStepProcess stamps spawnedAt and spawns synchronously, before its first await; an await ahead of the spawn would break this.
  let T;
  const h = resweepStaleHarness(dir, {
    preKill: () => [],
    reSweep: (root) => [row(root, 1, T), row(LATE, root, T + 500), row(STALE, LATE, T + 200), row(KID, LATE, T + 600)],
  });
  try {
    const p = h.run();
    T = Date.now();
    await p;
    assert.ok(h.swept.includes(LATE) && h.swept.includes(KID), `genuine later descendants are swept: ${JSON.stringify(h.swept)}`);
    assert.ok(!h.swept.includes(STALE), `a child older than its parent must not be followed (taskkill /T refuses it): ${JSON.stringify(h.swept)}`);
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: a recycled root pid (new holder + its child) is not swept (#3695)', async () => {
  const dir = mkTmp();
  const KID = 2147480020;
  const T = Date.now() + 100;
  const h = resweepStaleHarness(dir, {
    preKill: (root) => [row(root, 1, T)],
    // The root pid is now held by an unrelated, newer process with its own child.
    reSweep: (root) => [row(root, 1, T + 9000), row(KID, root, T + 9100)],
  });
  try {
    await h.run();
    assert.deepEqual(h.swept, [], `neither the recycled holder nor its child may be swept: ${JSON.stringify(h.swept)}`);
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: pre-kill snapshot failed => root bounded by spawn time, an older stale-ppid process is not swept, a newer child is (#3695)', async () => {
  const dir = mkTmp();
  const OLD = 2147480030;
  const NEW = 2147480031;
  const now = Date.now();
  // Valid only because runStepProcess stamps spawnedAt and spawns synchronously, before its first await; an await ahead of the spawn would break this.
  let afterSpawn;
  const h = resweepStaleHarness(dir, {
    preKill: () => null,
    // Root is dead by the re-sweep; OLD predates the step's spawn, NEW postdates it.
    // NEW is stamped right after the spawn (not at kill time, so a kill-time bound still fails), so it is always >= spawnedAt however slow setup was (#4005).
    reSweep: (root) => [row(OLD, root, now - 60_000), row(NEW, root, afterSpawn)],
  });
  try {
    const p = h.run();
    afterSpawn = Date.now();
    await p;
    assert.ok(!h.swept.includes(OLD), `a process older than the step's spawn must not be swept: ${JSON.stringify(h.swept)}`);
    assert.ok(h.swept.includes(NEW), `a child newer than the spawn is still swept: ${JSON.stringify(h.swept)}`);
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: pre-kill snapshot failed + a live row under the root pid that predates the spawn => not the root, neither it nor its child is swept (#3695)', async () => {
  const dir = mkTmp();
  const KID = 2147480045;
  const now = Date.now();
  const h = resweepStaleHarness(dir, {
    preKill: () => null,
    reSweep: (root) => [row(root, 1, now - 60_000), row(KID, root, now - 59_000)],
  });
  try {
    await h.run();
    assert.deepEqual(h.swept, [], `a process older than the step's spawn cannot be its root: ${JSON.stringify(h.swept)}`);
  } finally {
    h.cleanup();
  }
});


// A step root that exits ON ITS OWN while a detached descendant keeps the piped
// stderr open: Node fires 'exit' (and releases the root's pid for reuse) but
// never 'close', so the budget timer still fires. The holder pid is written to
// leak.pid so the test can clean it up. leak.start records a moment the root
// provably lived through (after the spawn, before the root's exit): the root
// can exit within ~100ms of spawn on Linux CI but ~550ms on Windows, so a genuine
// child's start must come from this, not from a fixed offset past spawn.
function writeLeakFixture(dir) {
  writeFileSync(
    join(dir, 'leak.mjs'),
    "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\n" +
      "writeFileSync('leak.start', String(Date.now()));\n" +
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true, windowsHide: true });\n" +
      "writeFileSync('leak.pid', String(c.pid));\nc.unref();\nprocess.exit(0);\n",
    'utf8',
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'leak-fixture', private: true, scripts: { leak: 'node leak.mjs' } }),
    'utf8',
  );
}

// null until leak.mjs has written a real timestamp.
function readLeakStart(dir) {
  const file = join(dir, 'leak.start');
  if (!existsSync(file)) return null;
  const t = Number(readFileSync(file, 'utf8'));
  return Number.isInteger(t) && t > 0 ? t : null;
}

function killLeakHolder(dir) {
  const pidFile = join(dir, 'leak.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}


// Pass-2 review 🟠2: once Node has seen the root's 'exit' it has released the
// root's process handle, so the pid may already belong to an unrelated process X.
test('runStepProcess re-sweep: root exited on its own and its pid was recycled before the pre-kill snapshot => X and its child are never killed, the genuine child is (#3695)', { timeout: 60_000 }, async () => {
  const dir = mkTmp();
  writeLeakFixture(dir);
  const K = 2147480060; // X's own child
  const L = 2147480061; // the real root's child, started while the root lived (leak.start)
  const U = 2147480062; // unrelated: names the root pid as ppid but predates the spawn by an hour
  const UK = 2147480063; // U's child
  let lStart = null;
  let xStart = null;
  let killCalls = 0;
  const swept = [];
  try {
    const result = await runStepProcess('leak', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      // The fixture's root exits within ~1-2s of launch; the budget fires well after.
      timeoutMs: 6000,
      killTreeFn: () => {
        killCalls += 1;
      },
      snapshotFn: (root) => {
        xStart ??= Date.now(); // X took the pid after the root's exit
        lStart ??= readLeakStart(dir);
        const rows = [row(root, 1, xStart), row(K, root, xStart + 1), row(U, root, xStart - 3_600_000), row(UK, U, xStart - 3_599_000)];
        if (lStart !== null) rows.push(row(L, root, lStart));
        return rows;
      },
      censusFn: NO_CENSUS,
      logFn: () => {},
      windows: true,
      resweepGraceMs: RESWEEP_TEST_GRACE_MS,
      resweepMax: 1,
      sweepKillFn: (pid) => swept.push(pid),
    });
    assert.equal(result.timedOut, true);
    assert.equal(killCalls, 0, 'the by-pid kill must be skipped once the root has exited: that pid is now X');
    assert.ok(lStart !== null, 'leak.start was never written: the fixture did not run before the snapshot');
    assert.ok(swept.includes(L), `the root's genuine child is swept: ${JSON.stringify(swept)}`);
    assert.equal(swept.length, 1, `only the genuine child — never X (the pid's new holder), X's child, or a pre-spawn process naming the root pid (U) and its child: ${JSON.stringify(swept)}`);
  } finally {
    killLeakHolder(dir);
  }
});


// Sweeps 2 and 3 exist for a recorded survivor that itself spawns again; by then
// the root has normally exited, so the exitedAt cap must bind the ROOT's edges
// only, never a survivor's.
test('runStepProcess re-sweep: a recorded survivor (not the root) that spawns a child after the root exited => that child is still swept (#3695)', { timeout: 60_000 }, async () => {
  const dir = mkTmp();
  writeLeakFixture(dir);
  const M = 2147480064; // recorded survivor, started while the root lived (leak.start)
  const C = 2147480065; // M's child, born after the root's exit
  let mStart = null;
  let xStart = null;
  let calls = 0;
  const swept = [];
  try {
    await runStepProcess('leak', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      timeoutMs: 6000,
      killTreeFn: () => {},
      snapshotFn: (root) => {
        calls += 1;
        xStart ??= Date.now();
        mStart ??= readLeakStart(dir);
        const rows = [row(root, 1, xStart)];
        if (mStart !== null) rows.push(row(M, root, mStart));
        // The re-sweep's snapshot runs after the root's exit: C starts "now".
        if (mStart !== null && calls > 1) rows.push(row(C, M, Date.now()));
        return rows;
      },
      censusFn: NO_CENSUS,
      logFn: () => {},
      windows: true,
      resweepGraceMs: RESWEEP_TEST_GRACE_MS,
      resweepMax: 1,
      sweepKillFn: (pid) => swept.push(pid),
    });
    assert.ok(mStart !== null, 'leak.start was never written: the fixture did not run before the snapshot');
    assert.deepEqual([...swept].sort(), [M, C].sort(), `the survivor and its post-exit child are both swept: ${JSON.stringify(swept)}`);
  } finally {
    killLeakHolder(dir);
  }
});


test('runStepProcess re-sweep: pre-kill snapshot failed + short budget + root pid recycled after its exit => the holder and its child are not swept, the genuine child is (#3695)', { timeout: 60_000 }, async () => {
  const dir = mkTmp();
  writeLeakFixture(dir);
  const HK = 2147480040; // the holder's child
  const G = 2147480041; // the real root's child, started while the root lived (leak.start)
  let gStart = null;
  let calls = 0;
  const swept = [];
  try {
    await runStepProcess('leak', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      // A run-deadline-clamped budget, far under 5s. The re-sweep lands ~4s
      // after spawn, after the fixture's root has exited.
      timeoutMs: 500,
      killTreeFn: () => {},
      snapshotFn: (root) => {
        calls += 1;
        if (calls === 1) throw new Error('snapshot failed');
        const now = Date.now();
        gStart ??= readLeakStart(dir);
        const rows = [row(root, 1, now - 50), row(HK, root, now - 40)];
        if (gStart !== null) rows.push(row(G, root, gStart));
        return rows;
      },
      censusFn: NO_CENSUS,
      logFn: () => {},
      windows: true,
      resweepGraceMs: 3500,
      resweepMax: 1,
      sweepKillFn: (pid) => swept.push(pid),
    });
    assert.ok(gStart !== null, 'leak.start was never written: the fixture did not run before the re-sweep');
    assert.deepEqual(swept, [G], `only the genuine child; the pid's post-exit holder and its child are never the step's: ${JSON.stringify(swept)}`);
  } finally {
    killLeakHolder(dir);
  }
});


// The SIGINT/SIGTERM/SIGHUP forwarder kills through killStepChildTree, which on
// Windows must not taskkill a pid Node has already released. The pids are far
// above any live one, so even a broken gate falling through to the real kill
// cannot hit a real process.
test('killStepChildTree: on Windows, a child Node has seen exit is not killed by its (released) pid; a live one is (#3695)', () => {
  const killed = [];
  const treeKill = (pid) => killed.push(pid);
  _internals.killStepChildTree({ pid: 2147480092, exitCode: 0, signalCode: null }, { windows: true, treeKill });
  _internals.killStepChildTree({ pid: 2147480096, exitCode: null, signalCode: 'SIGTERM' }, { windows: true, treeKill });
  assert.deepEqual(killed, [], `a released pid may belong to an unrelated process: ${JSON.stringify(killed)}`);
  _internals.killStepChildTree({ pid: 2147480100, exitCode: null, signalCode: null }, { windows: true, treeKill });
  assert.deepEqual(killed, [2147480100]);
});


test('runStepProcess re-sweep: seeds from every recorded pid, so the orphan of a dead intermediate is found (#3695)', async () => {
  const dir = mkTmp();
  const M = 2147480050; // alive pre-kill, dead by the re-sweep
  const L = 2147480051; // M's late child, orphaned: keeps ppid M
  const T = Date.now() + 100;
  const h = resweepStaleHarness(dir, {
    preKill: (root) => [row(root, 1, T), row(M, root, T + 10)],
    reSweep: (root) => [row(root, 1, T), row(L, M, T + 20)],
  });
  try {
    await h.run();
    assert.ok(h.swept.includes(L), `the orphan hangs off a recorded-but-dead pid and is only reachable by seeding from it: ${JSON.stringify(h.swept)}`);
  } finally {
    h.cleanup();
  }
});


// Pass-2 review 🟠1: the PRE-KILL closure must apply the same start ordering,
// or an unrelated process whose stale ppid names a step member becomes a seed.
// U is explorer-shaped: long-lived, its ppid a number a step process now holds.
const D_ = 2147480070;
const U_ = 2147480071;
const OLDV_ = 2147480072;
const V_ = 2147480073;
const V2_ = 2147480074;
test('runStepProcess re-sweep: a stale-ppid orphan in the PRE-KILL snapshot never becomes a seed, so neither it nor its children are swept (#3695)', async () => {
  const dir = mkTmp();
  const T = Date.now() + 100;
  const rows = (root) => [
    row(root, 1, T),
    row(D_, root, T + 10),
    row(U_, D_, T - 3_600_000),
    row(OLDV_, U_, T - 1_000_000),
    row(V_, U_, T + 50),
  ];
  const h = resweepStaleHarness(dir, { preKill: rows, reSweep: rows });
  try {
    await h.run();
    assert.deepEqual(
      [...h.swept].sort(),
      [h.child.pid, D_].sort(),
      `only the step's own members; U, OLDV and V are another tree: ${JSON.stringify(h.swept)}`,
    );
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: stale-ppid orphan in the pre-kill snapshot, D dead by the re-sweep, U spawns V2 after the kill => V2 not swept (#3695)', async () => {
  const dir = mkTmp();
  const T = Date.now() + 100;
  const h = resweepStaleHarness(dir, {
    preKill: (root) => [row(root, 1, T), row(D_, root, T + 10), row(U_, D_, T - 3_600_000)],
    reSweep: () => [row(U_, D_, T - 3_600_000), row(V2_, U_, T + 1500)],
  });
  try {
    await h.run();
    assert.deepEqual(h.swept, [], `V2 is U's child, not the step's: ${JSON.stringify(h.swept)}`);
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: an edge whose child started in the same ms as its parent is followed (the >= tie rule), for a non-seed child (#3695)', async () => {
  const dir = mkTmp();
  const TIE = 2147480080; // not in the pre-kill snapshot, so not a seed
  const T = Date.now() + 100;
  const h = resweepStaleHarness(dir, {
    preKill: (root) => [row(root, 1, T)],
    reSweep: (root) => [row(root, 1, T), row(TIE, root, T)],
  });
  try {
    await h.run();
    assert.ok(h.swept.includes(TIE), `an equal-start child is the parent's (taskkill /T's own tie rule): ${JSON.stringify(h.swept)}`);
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: windows:false => no process-table query, settles after one grace with the [timeout] line (#3695)', { timeout: 30_000 }, async () => {
  const dir = mkTmp();
  const h = resweepHarness(dir);
  let queried = 0;
  const start = Date.now();
  try {
    const result = await runStepProcess('hang', {
      cwd: dir,
      env: process.env,
      retryKey: 'test:server',
      timeoutMs: 500,
      killTreeFn: h.killTreeFn,
      snapshotFn: () => {
        queried += 1;
        return [];
      },
      censusFn: NO_CENSUS,
      logFn: h.logFn,
      windows: false,
      resweepGraceMs: RESWEEP_TEST_GRACE_MS,
      sweepKillFn: (pid) => h.swept.push(pid),
    });
    assert.equal(result.timedOut, true);
    assert.equal(queried, 0, 'POSIX never queries the process table');
    assert.deepEqual(h.swept, []);
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0], /\[timeout\] hang: 'close' not seen after the kill and 0 re-sweep\(s\)/);
    assert.ok(Date.now() - start < 500 + 5_000, 'must settle one grace after the kill, not at the fixture self-exit');
  } finally {
    h.cleanup();
  }
});


test('runStepProcess re-sweep: a step finishing inside its budget never queries the process table (#3695)', async () => {
  const dir = mkTmp();
  writeFileSync(join(dir, 'ok.mjs'), 'process.exit(0);\n', 'utf8');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'ok-fixture', private: true, scripts: { ok: 'node ok.mjs' } }),
    'utf8',
  );
  let queried = 0;
  const result = await runStepProcess('ok', {
    cwd: dir,
    env: process.env,
    retryKey: 'test:server',
    timeoutMs: 60_000,
    snapshotFn: () => {
      queried += 1;
      return [];
    },
    windows: true,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(queried, 0);
});


// Real-process proof: the first kill takes out ONLY the root (the partial-kill
// shape), leaving `npm`/`node hang.mjs` holding the piped stderr. Without the
// re-sweep the call would not return until the fixture's 300s self-exit.
test(
  'runStepProcess re-sweep: the real re-sweep reaps a surviving `node hang.mjs` and returns in seconds (#3695, win32)',
  { skip: process.platform !== 'win32' },
  async () => {
    const dir = mkTmp();
    writeHangingFixture(dir, 'hang');
    // The watch is only an orphan backstop here: arm it PAST the elapsed bound
    // below, so a slow pre-kill snapshot (up to ~30s on a wedged WMI) trips that
    // bound with its own "took Nms" message instead of the watch killing the
    // fixture first and misreporting a partial kill.
    const watch = armSurvivorWatch(dir, STEP_BUDGET_PAST_LAUNCH_MS + 45_000);
    const start = Date.now();
    try {
      const result = await runStepProcess('hang', {
        cwd: dir,
        env: process.env,
        retryKey: 'test:server',
        timeoutMs: STEP_BUDGET_PAST_LAUNCH_MS,
        censusFn: NO_CENSUS,
        resweepGraceMs: 1000,
        killTreeFn: (child) => {
          // Root only: no /T, so every descendant survives.
          spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore', windowsHide: true });
        },
      });
      const elapsed = Date.now() - start;
      assert.equal(result.timedOut, true);
      assert.equal(result.attempts, 1);
      assert.ok(
        elapsed < STEP_BUDGET_PAST_LAUNCH_MS + 40_000,
        `the re-sweep must release the step within seconds, not the fixture's ${HANG_FIXTURE_SELF_EXIT_MS}ms self-exit — took ${elapsed}ms`,
      );
      assertHangFixtureKilled(dir, elapsed, watch);
    } finally {
      watch.disarm();
    }
  },
);


// PR #3260 review pass 1, B2: a budget calibrated at full concurrency is too
// tight once LOW_CONCURRENCY has actually throttled the fork pool for THIS
// run — without accounting for that, the SAME throttle runPipeline applies
// to itself makes its own step timeout fire on an otherwise-healthy,
// merely-slower run.
//
// PR #3260 review pass 3, B9/B11: this used to be two tests that raced a
// real `npm run` subprocess against a wall-clock deadline. That went flaky
// on this box: real process-launch overhead alone (565-698ms measured on
// Windows) rivals the fixtures' own sleep durations, leaving 0-100ms of
// actual margin — both tests failed unmutated, repeatedly, on the
// committed head. Replaced with direct value assertions against
// computeStepBudgetMs/computeRunBudgetMs (no subprocess, no wall clock),
// PLUS a source-regex check that runPipeline's real call sites actually go
// through those functions rather than reimplementing the formula inline —
// together these prove both the arithmetic AND the wiring, deterministically.

