// scripts/tests/stop-app.test.mjs — PR #3404 review pass 1, yellow finding 4.
//
// stop-app.mjs's killTree() used to trust taskkill's own exit code (the same
// E104 defect fixed in scripts/reap-stale-batteries.mjs): a nonzero exit —
// which `/T` can produce even when the whole target tree is actually gone,
// see reap-stale-batteries.mjs's own E104 comment — made it print
// `[GONE] ... (already exited)` for a tree it had, in fact, just killed
// successfully, and could print `[OK] nothing to stop` right after. Fixed by
// probing liveness BEFORE the kill attempt (to classify "already exited"
// distinctly from "we killed it") and AGAIN afterward (to judge success by
// liveness, not by taskkill's exit code).
//
// Importing stop-app.mjs must NOT stop or sweep anything — main() is guarded
// behind an invoked-directly check (mirrors start-app-prod.mjs), so importing
// killTree() alone is side-effect-free.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killTree, isStopSummarySuppressed } from '../stop-app.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// killTree is async since PR #3404 review pass 2 (it now waits a bounded
// grace period after the kill attempt — see the file's own module-level
// comment). These four cases resolve `isAlive` to false on the very first
// post-kill check, so the wait inside killTree returns immediately without
// ever calling `sleep` — no real delay, same as before the fix.
const noSleep = async () => {};

test('killTree: pid already dead before the call -> "gone", no kill attempted', async () => {
  let attempted = false;
  const outcome = await killTree(4242, {
    isAlive: () => false,
    kill: () => {
      attempted = true;
    },
  });
  assert.equal(outcome, 'gone');
  assert.equal(attempted, false, 'a pid already confirmed dead must never trigger a kill attempt');
});

test('killTree: kill throws (E104 shape — taskkill exits nonzero) but the pid is actually gone afterward -> "killed"', async () => {
  let calls = 0;
  const outcome = await killTree(4242, {
    isAlive: () => {
      calls += 1;
      return calls === 1; // alive before the attempt, gone after
    },
    kill: () => {
      throw new Error('taskkill exited 128 (E104 shape)');
    },
    sleep: noSleep,
  });
  assert.equal(outcome, 'killed', 'a thrown/nonzero taskkill must not be trusted over the post-kill liveness check');
});

test('killTree: kill throws and the pid never exits -> "failed" after the grace period', async () => {
  // Injected clock advances past the deadline after the first poll — no real
  // wall-clock wait, mirroring restart-after-upgrade.test.mjs's own pattern.
  let t = 0;
  const now = () => (t += 40);
  const outcome = await killTree(4242, {
    isAlive: () => true,
    kill: () => {
      throw new Error('taskkill exited 1');
    },
    graceMs: 20,
    pollIntervalMs: 1,
    sleep: noSleep,
    now,
  });
  assert.equal(outcome, 'failed');
});

test('killTree: kill succeeds (no throw) and the pid is gone afterward -> "killed"', async () => {
  let calls = 0;
  const outcome = await killTree(4242, {
    isAlive: () => {
      calls += 1;
      return calls === 1;
    },
    kill: () => {},
    sleep: noSleep,
  });
  assert.equal(outcome, 'killed');
});

// PR #3404 review pass 2, orange finding 3 — pin the async-exit shape
// directly: the pid stays alive for a few polls (mirroring a real SIGTERM's
// asynchronous shutdown) before going away, and killTree must still report
// 'killed', not 'failed', once it catches up. Injected clock/no-op sleep
// keep this fast — no real wall-clock wait.
test('killTree: pid exits asynchronously after the kill request (dies after a few polls) -> "killed"', async () => {
  let polls = 0;
  let t = 0;
  const outcome = await killTree(4242, {
    isAlive: () => {
      polls += 1;
      return polls <= 3; // alive for the pre-kill check + 2 post-kill polls, then gone
    },
    kill: () => {},
    graceMs: 5000,
    pollIntervalMs: 1,
    sleep: noSleep,
    now: () => (t += 1),
  });
  assert.equal(outcome, 'killed');
  assert.ok(polls >= 4, 'expected multiple post-kill liveness polls before the pid read as gone');
});

test('isStopSummarySuppressed: a failed kill suppresses OK even with nothing still listening', () => {
  assert.equal(isStopSummarySuppressed(true, 0), true);
});

test('isStopSummarySuppressed: a still-listening port suppresses OK even with no failed kill', () => {
  assert.equal(isStopSummarySuppressed(false, 1), true);
});

test('isStopSummarySuppressed: no failure and nothing listening does not suppress', () => {
  assert.equal(isStopSummarySuppressed(false, 0), false);
});

// Pass 2, yellow finding 4a — the default `isAlive` wiring is untested by
// every case above (all four inject it). Two cases, both with NO isAlive
// override, so the default scripts/lib/pid-alive.mjs probe is what actually
// classifies the pid:
test('killTree: default isAlive wiring classifies an already-dead real pid as "gone"', async () => {
  // A pid this large is never a real running process (Windows caps live pids
  // well under this; POSIX pid_max is far lower too), so the default
  // pidIsAlive probe reads it as ESRCH -> gone without any override.
  const definitelyDeadPid = 999999;
  let attempted = false;
  const outcome = await killTree(definitelyDeadPid, {
    kill: () => {
      attempted = true;
    },
  });
  assert.equal(outcome, 'gone');
  assert.equal(attempted, false);
});

// The dead-pid case above alone does NOT kill the "default isAlive replaced
// by () => false" mutant — a probe that always reports "gone" happens to
// give the right answer for an already-dead pid too. This one closes that
// gap: THIS process is definitely alive, so the default probe must say so —
// a fail-open `() => false` default would read it as 'gone' and never even
// attempt the (harmless, no-op) kill below. graceMs/pollIntervalMs/sleep/now
// are overridden only to skip the real wall-clock wait; isAlive is left at
// its default on purpose.
test('killTree: default isAlive wiring reports a real live pid as alive, not "gone"', async () => {
  let killAttempted = false;
  let t = 0;
  const outcome = await killTree(process.pid, {
    kill: () => {
      killAttempted = true; // deliberately a no-op — must NOT actually kill this test process
    },
    graceMs: 5,
    pollIntervalMs: 1,
    sleep: noSleep,
    now: () => (t += 1),
  });
  assert.equal(killAttempted, true, 'a real live pid must trigger a kill attempt, not read as already gone');
  assert.equal(outcome, 'failed', 'the no-op kill never actually terminates this process, so it must read as failed');
});

// Pass 2, yellow finding 4b — the `isDirectlyInvoked` guard at the bottom of
// stop-app.mjs is not exercised by importing killTree() alone (that's the
// whole point: import must be side-effect-free). A POSITIVE control is
// required, not just "no stdout" — an empty .run/ dir would print nothing
// from a correctly-guarded import AND from an unguarded one that ran main()
// and found nothing to do, so that alone can't distinguish the mutation.
// Instead: plant a `server.pid` file in a real temp APP_RUN_DIR holding a
// pid that is definitely dead (999999 — see the sibling default-wiring test
// above for why). If the guard is intact, importing the module touches
// nothing: no stdout, and the pidfile survives (main() always rmSync's the
// pidfile it processes, before it even checks liveness). If the guard is
// removed (bare `main();`), main() reads that pid file, deletes it,
// classifies the pid 'gone' via the real default pidIsAlive probe, and
// prints `[GONE] server pid=999999 (already exited)` — this test fails on
// both counts under that mutation (verified by hand — see the PR report).
test('importing stop-app.mjs does not invoke main() (positive control: a dead-pid pidfile stays untouched)', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'stop-app-guard-'));
  writeFileSync(join(runDir, 'server.pid'), '999999', 'utf8');
  try {
    const moduleUrl = pathToFileURL(resolve(__dirname, '..', 'stop-app.mjs')).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import(${JSON.stringify(moduleUrl)});`],
      { cwd: resolve(__dirname, '..', '..'), env: { ...process.env, APP_RUN_DIR: runDir }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `import should not throw/exit nonzero: ${result.stderr}`);
    assert.equal(result.stdout, '', 'importing the module must not run main() or print anything');
    assert.ok(
      existsSync(join(runDir, 'server.pid')),
      'main() removes the pidfile it processes — it surviving proves main() never ran',
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
