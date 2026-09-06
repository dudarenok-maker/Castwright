// scripts/tests/reap-stale-batteries.test.mjs — #3047 (ops-71), Part 3 of
// docs/superpowers/specs/2026-09-05-commit-gate-rebalance-design.md.
//
// `classify()` is the pure, testable seam. This file's main fixture is an
// "11-battery census" (no literal historical dataset was committed to the
// repo for #2999/#3018/#3025's census runs to reuse — those captured no
// command lines at all, which is precisely the gap #3047 closes) built to
// cover, independently, every scenario the issue calls out by name:
//
//   B1  healthy, alive battery (live owner, high subtree CPU rate)
//   B2  genuinely stalled battery (live owner, near-zero rate over a
//       trusted window) — the RATE test's positive case
//   B3  orphaned + busy at ~5.67 CPU-s/min (2026-09-05's own figure) — the
//       REACHABILITY test's positive case, independent of rate
//   B4  orphaned + busy at ~2.59 CPU-s/min (2026-09-05's other figure) —
///      a second, independent proof of the same thing
//   B5  python.exe (TTS sidecar / Ringer) — orphaned AND stalled-looking,
//       must never be reaped
//   B6  git.exe overlap (a live git commit) — orphaned ancestor, must never
//       be reaped regardless
//   B7  the caller's own ancestor chain — must never be reaped
//   B8  a node -> cmd -> node -> cmd -> node alternating chain — must
//       resolve to ONE subtree, not four (the over-count correction)
//   B9  a supervisor that idles while its child is busy — verdict must be
//       judged on the SUBTREE sum, not the supervisor's own rate
//   B10 a rate sample taken too soon (elapsed < minSampleAgeMs) — the rate
//       must be distrusted even though it looks stalled
//   B11 a PID-reuse orphan — the recorded "parent" pid now belongs to an
//       unrelated, newer process; must still classify as orphaned
//
// Every fixture below is built so that deleting the guard it targets flips
// the verdict — see the "MUTATION VERIFICATION" section of the PR/task
// report for the delete -> rerun -> restore proof against each one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, runCli, runCensus } from '../reap-stale-batteries.mjs';

const MIN = 60_000;
const NOW = 2_000_000_000_000;
const THRESHOLDS = { deadRateCpuSecPerMin: 2, minSampleAgeMs: 10 * MIN };

function proc(pid, ppid, name, cpuSeconds, startedAt) {
  return { pid, ppid, name, commandLine: `${name} --battery=${pid}`, cpuSeconds, startedAt };
}

function verdictFor(verdicts, rootPid) {
  const v = verdicts.find((x) => x.rootPid === rootPid);
  assert.ok(v, `expected a verdict for rootPid=${rootPid}`);
  return v;
}

// ---------------------------------------------------------------------------
// The 11-battery census fixture
// ---------------------------------------------------------------------------

const processes = [
  // B1 — healthy, alive: live owner (1000, non-supervisor), busy subtree.
  proc(1000, 999, 'WindowsTerminal.exe', 0, NOW - 120 * MIN),
  proc(1001, 1000, 'cmd.exe', 12, NOW - 20 * MIN),
  proc(1002, 1001, 'node.exe', 40, NOW - 20 * MIN),
  proc(1003, 1002, 'node.exe', 900, NOW - 19 * MIN),

  // B2 — genuinely stalled: live owner, near-zero delta over 15 trusted min.
  proc(2000, 999, 'WindowsTerminal.exe', 0, NOW - 180 * MIN),
  proc(2001, 2000, 'cmd.exe', 5, NOW - 30 * MIN),
  proc(2002, 2001, 'node.exe', 8, NOW - 30 * MIN),
  proc(2003, 2002, 'node.exe', 300, NOW - 29 * MIN),

  // B3 — orphaned + busy (~5.67 CPU-s/min): parent pid 3000 never queried
  // (already dead) — the "top ancestor gone" branch with NO parent record
  // at all.
  proc(3001, 3000, 'cmd.exe', 5, NOW - 40 * MIN),
  proc(3002, 3001, 'node.exe', 580.05, NOW - 40 * MIN),

  // B4 — orphaned + busy (~2.59 CPU-s/min), same dead-parent shape as B3
  // but comfortably above the dead-rate bar too — a SECOND independent
  // proof that reachability, not speed, is what's firing.
  proc(4001, 4000, 'cmd.exe', 5, NOW - 50 * MIN),
  proc(4002, 4001, 'node.exe', 533.85, NOW - 50 * MIN),

  // B5 — python.exe: orphaned parent AND a stalled-looking rate, must
  // never be reaped (TTS sidecars / Ringer).
  proc(5001, 5000, 'python.exe', 10, NOW - 60 * MIN),

  // B6 — git.exe overlap: orphaned ancestor wrapping a live git commit
  // (the design doc's own 78-minute example), must never be reaped.
  proc(6001, 6000, 'cmd.exe', 5, NOW - 80 * MIN),
  proc(6002, 6001, 'git.exe', 3, NOW - 78 * MIN),

  // B7 — the caller's own ancestor chain: live owner, tiny cpu (would look
  // stalled on rate alone if it weren't self-protected).
  proc(7000, 999, 'WindowsTerminal.exe', 0, NOW - 60 * MIN),
  proc(7001, 7000, 'node.exe', 1, NOW - 5 * MIN),

  // B8 — node <-> cmd alternation, four hops deep, live owner at the top.
  // Must resolve to ONE subtree (rootPid=8001), not four.
  proc(8000, 999, 'WindowsTerminal.exe', 0, NOW - 180 * MIN),
  proc(8001, 8000, 'cmd.exe', 2, NOW - 25 * MIN),
  proc(8002, 8001, 'node.exe', 3, NOW - 25 * MIN),
  proc(8003, 8002, 'cmd.exe', 1, NOW - 24 * MIN),
  proc(8004, 8003, 'node.exe', 500, NOW - 23 * MIN),

  // B9 — supervisor (9001) idles while its child (9002) is busy. Judged on
  // the SUBTREE sum, never the supervisor's own delta.
  proc(9000, 999, 'WindowsTerminal.exe', 0, NOW - 60 * MIN),
  proc(9001, 9000, 'cmd.exe', 20, NOW - 30 * MIN),
  proc(9002, 9001, 'node.exe', 1000, NOW - 29 * MIN),

  // B10 — a rate sample taken too soon (elapsed 3 min < minSampleAgeMs
  // 10 min); the apparent rate (~0.03/min) would look stalled if trusted.
  proc(10000, 999, 'WindowsTerminal.exe', 0, NOW - 60 * MIN),
  proc(10001, 10000, 'cmd.exe', 5, NOW - 8 * MIN),

  // B11 — PID reuse: 11000 now holds an unrelated, NEWER process, so it
  // cannot really be 11001's parent even though a live pid sits there.
  proc(11000, 999, 'WindowsTerminal.exe', 0, NOW - 2 * MIN),
  proc(11001, 11000, 'cmd.exe', 50, NOW - 60 * MIN),
  proc(11002, 11001, 'node.exe', 900, NOW - 59 * MIN),
];

const priorSamples = {
  1001: { cpuSeconds: 452, sampledAt: NOW - 15 * MIN, startedAt: NOW - 20 * MIN },
  2001: { cpuSeconds: 311, sampledAt: NOW - 15 * MIN, startedAt: NOW - 30 * MIN },
  // B3 deliberately has NO prior entry — the "first time seen, no rate data
  // yet" shape, proving reachability fires with cpuRatePerMin still null.
  4001: { cpuSeconds: 500, sampledAt: NOW - 15 * MIN, startedAt: NOW - 50 * MIN },
  9001: { cpuSeconds: 500, sampledAt: NOW - 15 * MIN, startedAt: NOW - 30 * MIN },
  10001: { cpuSeconds: 4.9, sampledAt: NOW - 3 * MIN, startedAt: NOW - 8 * MIN },
};

const protectedPids = [7001];

function classifyCensus() {
  return classify({ processes, priorSamples, protectedPids }, NOW, THRESHOLDS);
}

// ---------------------------------------------------------------------------
// B1-B11 assertions
// ---------------------------------------------------------------------------

test('B1: healthy alive battery (live owner, high rate) is never reaped', () => {
  const v = verdictFor(classifyCensus(), 1001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, []);
  assert.ok(v.cpuRatePerMin > 30, `expected a high rate, got ${v.cpuRatePerMin}`);
});

test('B2: genuinely stalled battery (live owner, near-zero rate) is reaped via stalled-rate', () => {
  const v = verdictFor(classifyCensus(), 2001);
  assert.equal(v.verdict, 'reap');
  assert.deepEqual(v.reasons, ['stalled-rate']);
  assert.ok(v.cpuRatePerMin <= THRESHOLDS.deadRateCpuSecPerMin);
});

test('B3: orphaned + busy (~5.67 CPU-s/min) is reaped via reachability, NOT rate (no prior sample at all)', () => {
  const v = verdictFor(classifyCensus(), 3001);
  assert.equal(v.verdict, 'reap');
  assert.deepEqual(v.reasons, ['orphaned-unreachable']);
  assert.equal(v.cpuRatePerMin, null, 'no prior sample exists yet for this root');
});

test('B4: orphaned + busy (~2.59 CPU-s/min, WITH a prior sample proving it is busy) is reaped via reachability only', () => {
  const v = verdictFor(classifyCensus(), 4001);
  assert.equal(v.verdict, 'reap');
  assert.deepEqual(v.reasons, ['orphaned-unreachable']);
  // Busy — comfortably above the dead-rate bar — proving the orphan verdict
  // fires independently of how fast the subtree is working.
  assert.ok(v.cpuRatePerMin > THRESHOLDS.deadRateCpuSecPerMin, `expected busy, got ${v.cpuRatePerMin}`);
});

test('B5: python.exe (TTS sidecar / Ringer) is never reaped, even orphaned and stalled-looking', () => {
  const v = verdictFor(classifyCensus(), 5001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, ['protected:python']);
});

test('B6: a git.exe subtree (a live git commit) is never reaped, even orphaned', () => {
  const v = verdictFor(classifyCensus(), 6001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, ['protected:git-overlap']);
});

test('B7: the caller\'s own ancestor chain is never reaped', () => {
  // The battery's resolved root is 7001 (node.exe) — its climb stops at its
  // immediate parent 7000 (WindowsTerminal.exe, not supervisor-shaped), so
  // 7000 is the OWNER, not part of this subtree; 7001 is what protectedPids
  // actually names.
  const v = verdictFor(classifyCensus(), 7001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, ['protected:self-ancestry']);
});

test('B8: a node<->cmd alternating chain resolves to ONE subtree, not four (over-count correction)', () => {
  const verdicts = classifyCensus();
  // Exclusive of 8000 itself: that pid is the owner (WindowsTerminal.exe),
  // not part of the battery, and — like every synthetic "owner" in this
  // fixture — resolves as its own (irrelevant) single-node subtree because
  // its own ppid (999) was never queried. Only 8001-8004 are the battery.
  const inRange = verdicts.filter((v) => v.rootPid > 8000 && v.rootPid < 9000);
  assert.equal(inRange.length, 1, `expected exactly one subtree root in the 8000s, got ${inRange.length}`);
  assert.equal(inRange[0].rootPid, 8001);
  assert.deepEqual(inRange[0].subtreePids.slice().sort((a, b) => a - b), [8001, 8002, 8003, 8004]);
});

test('B9: verdict is judged on the subtree SUM, not the idling supervisor alone', () => {
  const v = verdictFor(classifyCensus(), 9001);
  assert.equal(v.verdict, 'alive');
  // Sum-based rate: (20+1000 - 500) / 15min = 34.67/min.
  assert.ok(v.cpuRatePerMin > 30, `expected the busy CHILD to dominate the rate, got ${v.cpuRatePerMin}`);
  // If this were computed off the supervisor's OWN delta alone
  // ((20 - <its share of 500>)/15min) it would land far below the dead-rate
  // bar; the subtree-sum rate must not.
  assert.ok(v.cpuRatePerMin > THRESHOLDS.deadRateCpuSecPerMin * 5);
});

test('B10: a rate sampled too soon (elapsed < minSampleAgeMs) is distrusted, not treated as stalled', () => {
  const v = verdictFor(classifyCensus(), 10001);
  assert.equal(v.verdict, 'alive');
  assert.equal(v.cpuRatePerMin, null, 'a 3-minute window must not produce a trusted rate');
});

test('B11: a reused PID cannot be the real parent — still classified as orphaned', () => {
  const v = verdictFor(classifyCensus(), 11001);
  assert.equal(v.verdict, 'reap');
  assert.deepEqual(v.reasons, ['orphaned-unreachable']);
});

// ---------------------------------------------------------------------------
// Additional targeted assertions (acceptance criteria 1-2)
// ---------------------------------------------------------------------------

test('reachability and rate are independent axes: an orphan with a busy AND a stalled counterpart both reap for DIFFERENT reasons', () => {
  const verdicts = classifyCensus();
  const busyOrphan = verdictFor(verdicts, 4001);
  const stalledLiveParent = verdictFor(verdicts, 2001);
  assert.deepEqual(busyOrphan.reasons, ['orphaned-unreachable']);
  assert.deepEqual(stalledLiveParent.reasons, ['stalled-rate']);
  assert.notDeepEqual(busyOrphan.reasons, stalledLiveParent.reasons);
});

test('classify() reports every root, not just reap candidates (the census log needs every command line)', () => {
  const verdicts = classifyCensus();
  const aliveRoots = verdicts.filter((v) => v.verdict === 'alive');
  const reapRoots = verdicts.filter((v) => v.verdict === 'reap');
  assert.ok(aliveRoots.length > 0);
  assert.ok(reapRoots.length > 0);
  for (const v of verdicts) {
    assert.ok(typeof v.commandLine === 'string' && v.commandLine.length > 0);
  }
});

// ---------------------------------------------------------------------------
// runCensus() — the log-writing / kill-scoping / never-blocks-push contract
// ---------------------------------------------------------------------------

test('runCensus: appends a log entry carrying every root\'s command line', () => {
  const appended = [];
  const { verdicts } = runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: (entry) => appended.push(entry),
    kill: false,
    thresholds: THRESHOLDS,
    now: NOW,
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].ts, NOW);
  assert.equal(appended[0].roots.length, verdicts.length);
  for (const root of appended[0].roots) {
    assert.ok(typeof root.commandLine === 'string' && root.commandLine.length > 0, 'the 2026-09-05 census omitted this');
  }
});

test('runCensus: pre-push kill scope (killReasons=[orphaned-unreachable]) kills orphans only, never a merely-stalled live-parented subtree', () => {
  const killedPids = [];
  const { killed } = runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: () => {},
    kill: true,
    killReasons: ['orphaned-unreachable'],
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: (pid) => {
      killedPids.push(pid);
      return true;
    },
  });
  // B3/B4/B11 are the orphaned-unreachable reap candidates; B2 (stalled-rate,
  // live parent) must NOT be among them.
  assert.ok(killed.includes(3001));
  assert.ok(killed.includes(4001));
  assert.ok(killed.includes(11001));
  assert.ok(!killed.includes(2001), 'stalled-but-live-parented battery must survive the pre-push scope');
  assert.deepEqual(killedPids.slice().sort((a, b) => a - b), killed.slice().sort((a, b) => a - b));
});

test('runCensus: report-only mode (kill=false) never calls killFn', () => {
  let called = false;
  runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: () => {},
    kill: false,
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: () => {
      called = true;
      return true;
    },
  });
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// runCli() — the "never blocks the push" contract, proven, not asserted
// ---------------------------------------------------------------------------

test('runCli: always returns 0, even when the census throws (pre-push must never block)', () => {
  const code = runCli(['--pre-push'], {
    runCensusFn: () => {
      throw new Error('simulated PowerShell failure');
    },
  });
  assert.equal(code, 0);
});

test('runCli: --pre-push scopes the kill to orphaned-unreachable only', () => {
  let seenKillReasons;
  runCli(['--pre-push'], {
    runCensusFn: (opts) => {
      seenKillReasons = opts.killReasons;
      return { verdicts: [], killed: [] };
    },
  });
  assert.deepEqual(seenKillReasons, ['orphaned-unreachable']);
});

test('runCli: --kill (the manual doctor path) allows both reap reasons', () => {
  let seenKillReasons;
  runCli(['--kill'], {
    runCensusFn: (opts) => {
      seenKillReasons = opts.killReasons;
      return { verdicts: [], killed: [] };
    },
  });
  assert.deepEqual(seenKillReasons.slice().sort(), ['orphaned-unreachable', 'stalled-rate'].sort());
});

test('runCli: report-only mode (no flags) never sets kill=true', () => {
  let seenKill;
  runCli([], {
    runCensusFn: (opts) => {
      seenKill = opts.kill;
      return { verdicts: [], killed: [] };
    },
  });
  assert.equal(seenKill, false);
});
