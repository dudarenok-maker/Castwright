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
// Importing stop-app.mjs must NOT stop or sweep anything — that guard is
// pinned in stop-app-import-guard.test.mjs, which deliberately never imports
// stop-app.mjs itself (a test file that statically imports it would run the
// guard's own mutant inside the importing process).
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTree, isStopSummarySuppressed, main } from '../stop-app.mjs';

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
  // The pid of a child that has just exited — a real pid that is genuinely
  // dead, unlike a made-up large number (Windows ignores a pid's low two bits,
  // so a fixed "999999" can alias a live pid).
  const definitelyDeadPid = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
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

// PR #3404 review pass 3, yellow B — the shipped defaults and main()'s summary
// wiring. Every killTree case above injects `graceMs`, so a default of 0
// (which reads a POSIX SIGTERM that is still shutting down as 'failed')
// survived the whole suite.
test('killTree: the default grace period is a real, non-trivial wait (not 0)', async () => {
  let seen = null;
  const outcome = await killTree(4242, {
    isAlive: () => true,
    kill: () => {},
    wait: async ({ timeoutMs, intervalMs }) => {
      seen = { timeoutMs, intervalMs };
      return true;
    },
  });
  assert.equal(outcome, 'killed');
  assert.ok(seen.timeoutMs >= 1000, `default grace must be >= 1s, got ${seen.timeoutMs}ms`);
  assert.ok(seen.intervalMs > 0 && seen.intervalMs < seen.timeoutMs);
});

// Drive main() end-to-end with an injected kill outcome per pidfile, so the
// failedAny / stillListening summary wiring is exercised at its call site.
async function runMain({ server, tts }) {
  const runDir = mkdtempSync(join(tmpdir(), 'stop-app-main-'));
  const outcomeByPid = { 1111: server, 2222: tts };
  if (server) writeFileSync(join(runDir, 'server.pid'), '1111', 'utf8');
  if (tts) writeFileSync(join(runDir, 'tts.pid'), '2222', 'utf8');
  const lines = [];
  let exitCode = null;
  try {
    await main({
      kill: async (pid) => outcomeByPid[pid],
      runDirPath: runDir,
      probe: async () => false,
      log: (l) => lines.push(l),
      exit: (c) => {
        exitCode = c;
      },
    });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
  return { out: lines.join('\n'), exitCode };
}

test('main: a failed kill is reported and never co-prints [OK] nothing to stop', async () => {
  const { out, exitCode } = await runMain({ server: 'failed' });
  assert.match(out, /\[WARN\] server pid=1111 could not be stopped/);
  assert.doesNotMatch(out, /\[OK\]/);
  assert.equal(exitCode, 0);
});

test('main: a failed kill stays sticky across a later pid that was already gone', async () => {
  const { out } = await runMain({ server: 'failed', tts: 'gone' });
  assert.match(out, /\[GONE\] tts pid=2222/);
  assert.doesNotMatch(out, /\[OK\]/);
});

test('main: positive control — every pid already gone prints [GONE] and the OK summary', async () => {
  const { out } = await runMain({ server: 'gone', tts: 'gone' });
  assert.match(out, /\[GONE\] server pid=1111/);
  assert.match(out, /\[OK\] nothing to stop/);
});

test('main: a killed pid prints [STOP] and no OK summary', async () => {
  const { out } = await runMain({ server: 'killed' });
  assert.match(out, /\[STOP\] server pid=1111/);
  assert.doesNotMatch(out, /\[OK\]/);
});
