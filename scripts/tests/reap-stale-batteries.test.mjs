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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classify,
  runCli,
  runCensus,
  rowsToProcesses,
  computeOsDescendants,
  readPriorSamples,
} from '../reap-stale-batteries.mjs';

const MIN = 60_000;
const NOW = 2_000_000_000_000;
const THRESHOLDS = { deadRateCpuSecPerMin: 2, minSampleAgeMs: 10 * MIN };

// A "battery" is only ever a reap candidate once its command line carries a
// real test-runner marker (BATTERY_COMMAND_RE, Finding 2 of PR #3063's
// review) — every node.exe member here stands in for a real `vitest` worker,
// so it needs that marker for the existing B1-B11 scenarios to still
// represent genuine batteries rather than accidentally falling through to
// 'alive' regardless of orphan/stall status.
function proc(pid, ppid, name, cpuSeconds, startedAt) {
  const isBatteryProcess = /^node(?:\.exe)?$/i.test(name);
  const commandLine = isBatteryProcess
    ? `${name} node_modules/vitest/dist/vitest.mjs run --battery=${pid}`
    : `${name} --battery=${pid}`;
  return { pid, ppid, name, commandLine, cpuSeconds, startedAt };
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

  // B12 — steam.exe: orphaned parent AND near-zero rate BY THE NUMBERS, but
  // no battery marker anywhere in its command line. Finding 2's positive
  // case: must classify alive/[] purely because it was never battery-shaped,
  // even though both the orphan and stall tests would otherwise fire.
  proc(12001, 12000, 'steam.exe', 5, NOW - 90 * MIN),

  // B13 — "ollama app.exe" (the literal Win32_Process Name the review
  // captured live): same shape as B12, a second independent proof.
  proc(13001, 13000, 'ollama app.exe', 5, NOW - 90 * MIN),

  // B14 — Finding 3's structural bug: an orphaned, battery-shaped root R
  // (14001, cmd.exe) whose real OS descendant chain runs THROUGH a
  // non-supervisor-shaped intermediate (14002, conhost.exe) down to a live
  // python.exe (14003). classify()'s upward climb from 14003 stops at
  // conhost.exe (not supervisor-shaped), so 14003 resolves to ITS OWN
  // subtree (protected:python, alive) — a DIFFERENT subtree than R's. But
  // `taskkill /PID 14001 /T /F` reaches straight through conhost.exe into
  // 14003 regardless: classify()'s subtree grouping is not what /T kills.
  { ...proc(14001, 14000, 'cmd.exe', 5, NOW - 40 * MIN), commandLine: 'cmd.exe /c npx vitest run --battery=14001' },
  proc(14002, 14001, 'conhost.exe', 1, NOW - 40 * MIN),
  proc(14003, 14002, 'python.exe', 2, NOW - 40 * MIN),

  // B15 — the generic form of the same structural bug, WITHOUT relying on a
  // protected name: R2 (15001, cmd.exe, battery-shaped, orphaned) reaches
  // 15003 (WindowsTerminal.exe) through the same non-supervisor intermediate
  // (15002, conhost.exe). 15003 is not python/git-named — it is caught only
  // by classify()'s subtree grouping saying it belongs to a DIFFERENT,
  // 'alive' subtree (it carries no battery marker of its own either).
  { ...proc(15001, 15000, 'cmd.exe', 5, NOW - 40 * MIN), commandLine: 'cmd.exe /c npx vitest run --battery=15001' },
  proc(15002, 15001, 'conhost.exe', 1, NOW - 40 * MIN),
  proc(15003, 15002, 'WindowsTerminal.exe', 1, NOW - 40 * MIN),
];

const priorSamples = {
  1001: { cpuSeconds: 452, sampledAt: NOW - 15 * MIN, startedAt: NOW - 20 * MIN },
  2001: { cpuSeconds: 311, sampledAt: NOW - 15 * MIN, startedAt: NOW - 30 * MIN },
  // B3 deliberately has NO prior entry — the "first time seen, no rate data
  // yet" shape, proving reachability fires with cpuRatePerMin still null.
  4001: { cpuSeconds: 500, sampledAt: NOW - 15 * MIN, startedAt: NOW - 50 * MIN },
  9001: { cpuSeconds: 500, sampledAt: NOW - 15 * MIN, startedAt: NOW - 30 * MIN },
  10001: { cpuSeconds: 4.9, sampledAt: NOW - 3 * MIN, startedAt: NOW - 8 * MIN },
  // B12/B13 — near-zero rate BY THE NUMBERS (delta 0.1 over 15 trusted
  // minutes), proving these would stall-reap if they were battery-shaped.
  12001: { cpuSeconds: 4.9, sampledAt: NOW - 15 * MIN, startedAt: NOW - 90 * MIN },
  13001: { cpuSeconds: 4.9, sampledAt: NOW - 15 * MIN, startedAt: NOW - 90 * MIN },
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
// B12-B13 — Finding 2: "battery" gates candidacy, independent of the orphan
// and rate tests
// ---------------------------------------------------------------------------

test('B12: an orphaned, near-zero-rate steam.exe is never reaped — it never carried a battery marker', () => {
  const v = verdictFor(classifyCensus(), 12001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, []);
});

test('B13: an orphaned, near-zero-rate "ollama app.exe" is never reaped either — a second independent proof', () => {
  const v = verdictFor(classifyCensus(), 13001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, []);
});

// ---------------------------------------------------------------------------
// computeOsDescendants() — Finding 3: taskkill /T's real reach vs.
// classify()'s supervisor-bounded subtree
// ---------------------------------------------------------------------------

test('computeOsDescendants: follows forward ppid links unboundedly, with no name/supervisor filtering', () => {
  const descendants = computeOsDescendants(14001, processes);
  assert.ok(descendants.has(14001), 'includes the root itself');
  assert.ok(descendants.has(14002), 'reaches the non-supervisor-shaped conhost.exe');
  assert.ok(descendants.has(14003), 'reaches straight through into python.exe');
});

test('computeOsDescendants: does not cross into an unrelated subtree it was never asked about', () => {
  const descendants = computeOsDescendants(14001, processes);
  assert.ok(!descendants.has(15001), 'B15\'s root is not a descendant of B14\'s root');
});

test("B14: classify() alone marks R 'reap', but R's real /T reach contains a live python.exe classify() protects in a DIFFERENT subtree", () => {
  const verdicts = classifyCensus();
  const r = verdictFor(verdicts, 14001);
  assert.equal(r.verdict, 'reap', "classify() alone has no way to see the collision — it's still 'reap' here");
  const x = verdictFor(verdicts, 14003);
  assert.equal(x.verdict, 'alive');
  assert.deepEqual(x.reasons, ['protected:python']);
  assert.notEqual(r.rootPid, x.rootPid, 'classify() buckets R and X into DIFFERENT subtrees');
});

test('B15: the generic form — R2 reap-eligible alone, but its real descendant closure reaches a separately-alive subtree with no protected name at all', () => {
  const verdicts = classifyCensus();
  const r2 = verdictFor(verdicts, 15001);
  assert.equal(r2.verdict, 'reap');
  const y = verdictFor(verdicts, 15003);
  assert.equal(y.verdict, 'alive');
  assert.deepEqual(y.reasons, [], 'alive purely because it never carried a battery marker, not because of a name');
  assert.notEqual(r2.rootPid, y.rootPid);
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
  // B14/B15's roots ARE orphaned-unreachable reap candidates by classify()
  // alone, but their real /T reach hits a protected/alive process filed
  // under a different subtree — the runCensus-level safety check must
  // refuse them, not kill them.
  assert.ok(!killed.includes(14001), "B14's root must be refused, not killed");
  assert.ok(!killed.includes(15001), "B15's root must be refused, not killed");
  assert.deepEqual(killedPids.slice().sort((a, b) => a - b), killed.slice().sort((a, b) => a - b));
});

test('runCensus: findKillRefusalReason refuses B14\'s root — real /T reach hits a live python.exe classify() protects elsewhere', () => {
  const { killed, refused } = runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: () => {},
    kill: true,
    killReasons: ['orphaned-unreachable'],
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: () => true,
  });
  assert.ok(!killed.includes(14001));
  const entry = refused.find((r) => r.rootPid === 14001);
  assert.ok(entry, 'expected 14001 in refused');
  assert.match(entry.reason, /python/i);
});

test('runCensus: findKillRefusalReason refuses B15\'s root — real /T reach hits a separately-alive subtree, no protected name involved', () => {
  const { killed, refused } = runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: () => {},
    kill: true,
    killReasons: ['orphaned-unreachable'],
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: () => true,
  });
  assert.ok(!killed.includes(15001));
  const entry = refused.find((r) => r.rootPid === 15001);
  assert.ok(entry, 'expected 15001 in refused');
  assert.match(entry.reason, /15003/);
});

test('runCensus: a genuinely safe orphan (no collateral in its real /T reach) is still killed, not refused', () => {
  const { killed, refused } = runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: () => {},
    kill: true,
    killReasons: ['orphaned-unreachable'],
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: () => true,
  });
  assert.ok(killed.includes(3001));
  assert.ok(!refused.some((r) => r.rootPid === 3001));
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

test('runCli: report mode surfaces a refused root distinctly from alive/reap [KILLED]', () => {
  const lines = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    runCli([], {
      runCensusFn: () => ({
        verdicts: [
          {
            rootPid: 14001,
            name: 'cmd.exe',
            commandLine: 'cmd.exe /c npx vitest run',
            cpuRatePerMin: null,
            verdict: 'reap',
            reasons: ['orphaned-unreachable'],
          },
        ],
        killed: [],
        refused: [{ rootPid: 14001, reason: 'real OS descendant pid=14003 is python.exe' }],
      }),
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  const output = lines.join('');
  assert.match(output, /\[REFUSED: real OS descendant pid=14003 is python\.exe\]/);
  assert.doesNotMatch(output, /\[KILLED\]/);
});

// ---------------------------------------------------------------------------
// rowsToProcesses() — the collection layer's unit-testable seam (Finding 1's
// review: zero coverage previously existed for this layer, which is exactly
// where the date-parsing bug lived undetected).
// ---------------------------------------------------------------------------

test('rowsToProcesses: maps a realistic row (numeric CreationEpochMs) into the process shape classify() expects', () => {
  const rows = [
    {
      ProcessId: 12345,
      ParentProcessId: 999,
      Name: 'node.exe',
      CommandLine: 'node vitest run',
      CreationEpochMs: 1788727332170,
      CpuSeconds: 42.5,
    },
  ];
  const out = rowsToProcesses(rows);
  assert.deepEqual(out, [
    { pid: 12345, ppid: 999, name: 'node.exe', commandLine: 'node vitest run', cpuSeconds: 42.5, startedAt: 1788727332170 },
  ]);
});

test('rowsToProcesses: filters out a row with a malformed/missing CreationEpochMs', () => {
  const rows = [
    { ProcessId: 1, ParentProcessId: 0, Name: 'a.exe', CommandLine: null, CreationEpochMs: null, CpuSeconds: 0 },
    { ProcessId: 2, ParentProcessId: 0, Name: 'b.exe', CommandLine: null, CreationEpochMs: '/Date(1788727332170)/', CpuSeconds: 0 },
    { ProcessId: 3, ParentProcessId: 0, Name: 'c.exe', CpuSeconds: 0 }, // missing entirely
    { ProcessId: 4, ParentProcessId: 0, Name: 'ok.exe', CreationEpochMs: 1788727332170, CpuSeconds: 1 },
  ];
  const out = rowsToProcesses(rows);
  assert.deepEqual(out.map((p) => p.pid), [4]);
});

test('rowsToProcesses: filters out a row missing ProcessId/ParentProcessId', () => {
  const rows = [
    { ParentProcessId: 0, Name: 'a.exe', CreationEpochMs: 1, CpuSeconds: 0 },
    { ProcessId: 1, Name: 'b.exe', CreationEpochMs: 1, CpuSeconds: 0 },
  ];
  assert.deepEqual(rowsToProcesses(rows), []);
});

// ---------------------------------------------------------------------------
// readPriorSamples() — stale-sample preference under rapid pushes, and
// tail-bounded reading
// ---------------------------------------------------------------------------

function withTempLog(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'reap-stale-batteries-test-'));
  const logPath = join(dir, 'census.jsonl');
  try {
    return fn(logPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readPriorSamples: prefers the most recent sample that is ALREADY old enough, not simply the newest', () => {
  withTempLog((logPath) => {
    const rootPid = 99001;
    const t1 = NOW - 6 * MIN;
    const t2 = NOW - 3 * MIN;
    const t3 = NOW; // "now" is close to this one
    const lines = [t1, t2, t3]
      .map((ts, i) => JSON.stringify({ ts, roots: [{ rootPid, cpuSecondsNow: 10 + i, startedAt: 500 }] }))
      .join('\n');
    writeFileSync(logPath, `${lines}\n`, 'utf8');

    // minSampleAgeMs=5min: elapsed(t3)=0 and elapsed(t2)=3min both too
    // recent; elapsed(t1)=6min qualifies. Must pick t1, not t3.
    const samples = readPriorSamples(logPath, { now: t3 + 100, minSampleAgeMs: 5 * MIN });
    assert.equal(samples[rootPid].sampledAt, t1, 'expected the OLDEST-but-still-valid sample, not the newest');
    assert.equal(samples[rootPid].cpuSeconds, 10);
  });
});

test('readPriorSamples: falls back to the newest sample when none is old enough yet', () => {
  withTempLog((logPath) => {
    const rootPid = 99002;
    const ts = NOW - MIN; // 1 minute old
    writeFileSync(logPath, `${JSON.stringify({ ts, roots: [{ rootPid, cpuSecondsNow: 5, startedAt: 500 }] })}\n`, 'utf8');
    const samples = readPriorSamples(logPath, { now: NOW, minSampleAgeMs: 10 * MIN });
    assert.equal(samples[rootPid].sampledAt, ts, 'still returns the only sample available, letting classify() reject it');
  });
});

test('readPriorSamples: missing log file returns {}', () => {
  withTempLog((logPath) => {
    assert.deepEqual(readPriorSamples(logPath), {});
  });
});

test('readPriorSamples: a tiny tail window still returns the most recent entries without throwing', () => {
  withTempLog((logPath) => {
    const entries = [];
    for (let i = 0; i < 20; i += 1) {
      entries.push(JSON.stringify({ ts: NOW - (20 - i) * MIN, roots: [{ rootPid: 90000 + i, cpuSecondsNow: i, startedAt: 1 }] }));
    }
    writeFileSync(logPath, `${entries.join('\n')}\n`, 'utf8');
    // A window far smaller than the whole file — only the tail few entries
    // can possibly be read back.
    const samples = readPriorSamples(logPath, { now: NOW, minSampleAgeMs: 0, tailBytes: 200 });
    assert.ok(Object.keys(samples).length > 0, 'expected at least the trailing entries to parse');
    assert.ok(!('90000' in samples), 'the earliest entry must be outside a 200-byte tail window');
  });
});
