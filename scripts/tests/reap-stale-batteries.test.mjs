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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classify,
  runCli,
  runCensus,
  rowsToProcesses,
  computeOsDescendants,
  readPriorSamples,
  appendCensusLog,
  collectProcessSnapshot,
  isBatteryInvocation,
  killTree,
  tailBytesFor,
  tokenizeCommandLine,
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
  // Explicitly battery-shaped: without a recognised runner invocation this
  // root would classify 'alive' because it was never a candidate at all, and
  // the minSampleAgeMs guard this row exists to pin would carry no weight.
  {
    ...proc(10001, 10000, 'cmd.exe', 5, NOW - 8 * MIN),
    commandLine: 'cmd.exe /c npx vitest run --battery=10001',
  },

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

  // B16 — PR #3063 review pass 2, C2. The reviewer's OWN probe shell: an
  // orphaned bash whose -c payload greps FOR the runner names. The old
  // substring gate matched it (the words are right there in the argv) and,
  // as a lone root with no descendants, findKillRefusalReason returned null,
  // so taskkill /T /F fired on it unattended on every push. It runs grep, not
  // a battery, so it must never be a candidate.
  {
    ...proc(16001, 16000, 'bash.exe', 0.2, NOW - 40 * MIN),
    commandLine:
      '"C:\\Program Files\\Git\\bin\\bash.exe" -c "grep -iE \'vitest|pytest|invoke-pester\' census.txt"',
  },

  // B17 — the same class, second shape: an orphaned, idle `tail -f` on a
  // LOG whose filename contains a runner name. Recorded live on this box.
  {
    ...proc(17001, 17000, 'tail.exe', 0.1, NOW - 40 * MIN),
    commandLine: 'tail -f C:/Claude/Projects/wt-3051-worktree-gc/logs/vitest.log',
  },

  // B18 — PR #3063 review pass 2, C1: `npm run test:hooks` bottoms out in
  // `node --test <file>`, one forked child per file (98 of them). It is a
  // pool and it IS orphan-generating, and the old three-token gate could not
  // see it at all. Command line recorded live (reviewer's pid 42100).
  {
    ...proc(18001, 18000, 'node.exe', 5, NOW - 40 * MIN),
    commandLine: 'node --test C:/Claude/Projects/wt-3051-worktree-gc/scripts/tests/verify-cache.test.mjs',
  },

  // B19 — C1, second harness: `npm run test:scripts` spawns this launcher
  // (run-powershell.mjs:52). `Invoke-Pester` itself is in-process and never
  // reaches any command line — the launcher PATH is the only handle there is.
  {
    ...proc(19001, 19000, 'pwsh.exe', 5, NOW - 40 * MIN),
    commandLine: 'pwsh -ExecutionPolicy Bypass -NoProfile -File C:/Claude/Projects/wt-x/scripts/tests/run.ps1',
  },

  // B20 — C1, third harness: Playwright (`npm run test:e2e`). Anchored on the
  // package directory, since `cli.js` on its own is far too generic a name.
  {
    ...proc(21001, 21000, 'node.exe', 5, NOW - 40 * MIN),
    commandLine: 'node C:/Claude/Projects/wt-x/node_modules/playwright/cli.js test --project=chromium',
  },
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

// ---------------------------------------------------------------------------
// C2 — the gate must recognise a runner INVOCATION, never a mention
// (PR #3063 review pass 2). Both fixtures below were recorded live on this box
// by the reviewer, and both were force-killed by the substring version.
// ---------------------------------------------------------------------------

test('C2: an orphaned probe shell whose -c payload GREPS FOR the runner names is never a candidate', () => {
  const v = verdictFor(classifyCensus(), 16001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, [], 'it runs grep; grep runs no battery');
});

test('C2: an orphaned, idle `tail -f .../vitest.log` is never a candidate either', () => {
  const v = verdictFor(classifyCensus(), 17001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, [], 'a log FILENAME containing a runner name is not a runner');
});

test('C2: neither non-battery shape is ever killed, even on the pre-push (orphan-only) kill scope', () => {
  const { killed } = runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: () => {},
    kill: true,
    killReasons: ['orphaned-unreachable'],
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: () => true,
  });
  assert.ok(!killed.includes(16001), "the reviewer's own probe shell must survive a push");
  assert.ok(!killed.includes(17001), 'an orphaned tail -f must survive a push');
});

test('C2: isBatteryInvocation keys on the executable and argv position, not on a substring anywhere', () => {
  // Mentions, in every position that used to match — none of them run a battery.
  assert.equal(isBatteryInvocation('tail -f C:/repo/logs/vitest.log'), false);
  assert.equal(isBatteryInvocation('grep -iE vitest|pytest|invoke-pester census.txt'), false);
  assert.equal(isBatteryInvocation('bash -c "grep -iE vitest census.txt"'), false);
  assert.equal(isBatteryInvocation('code --goto C:/repo/src/vitest.config.ts'), false);
  assert.equal(isBatteryInvocation('node C:/repo/scripts/summarise-pytest-output.mjs'), false);
  // Real invocations, in the shapes this repo actually produces.
  assert.equal(isBatteryInvocation('node C:/repo/node_modules/vitest/dist/vitest.mjs run'), true);
  assert.equal(isBatteryInvocation('cmd.exe /c npx vitest run --reporter=dot'), true);
  assert.equal(isBatteryInvocation('C:/repo/node_modules/.bin/vitest.cmd run'), true);
});

test('C2: tokenizeCommandLine groups quoted arguments so an executable path with spaces still resolves', () => {
  const tokens = tokenizeCommandLine('"C:\\Program Files\\Git\\bin\\bash.exe" -c "grep -iE vitest f.txt"');
  assert.deepEqual(tokens, ['C:\\Program Files\\Git\\bin\\bash.exe', '-c', 'grep -iE vitest f.txt']);
});

test('review pass 3: an unrecognised shell-flag shape does not fall back to substring-scanning the whole payload', () => {
  // Each of these has a runner PATH somewhere inside its payload, but the
  // shell flag isn't one this gate unwraps — the fix must NOT fall through
  // to scanning all of argv for a runner path (that was C2's own hole,
  // narrowed to this one path rather than closed).
  assert.equal(isBatteryInvocation('bash -lc "vim /c/repo/scripts/tests/run.ps1"'), false);
  assert.equal(isBatteryInvocation('sh -lc "tail -f /c/repo/node_modules/vitest/x.log"'), false);
  // powershell's positional -Command binding: an unflagged string argument.
  assert.equal(isBatteryInvocation('powershell "Get-Content C:/repo/scripts/run-hooks-tests.mjs"'), false);
  // An abbreviated -Command flag (pwsh accepts any unambiguous prefix).
  assert.equal(isBatteryInvocation('pwsh -Comm "Get-Content C:/repo/scripts/run-hooks-tests.mjs"'), false);
  // A genuine shell-wrapped battery must still qualify in both directions —
  // the fix must not reject shells outright.
  assert.equal(isBatteryInvocation('cmd /c npx vitest run'), true);
  assert.equal(isBatteryInvocation('pwsh -Comm "npx vitest run"'), true);
  // Unquoted, multi-token command after the abbreviated flag: the whole
  // remainder of argv is the -Command payload, not just the first token —
  // this is the case a "just fall back to the first non-flag arg" fix would
  // still get wrong (it would recurse on `node` alone, with none of the
  // following args, and lose the runner path entirely).
  assert.equal(isBatteryInvocation('pwsh -Comm node C:/repo/node_modules/vitest/dist/vitest.mjs run'), true);
});

test('N6: node and npx do not substring-match multiword arguments that happen to name a runner', () => {
  // The N6 residual: node/npx checks `args.some(isRunnerScriptPath)` on
  // arbitrary argv tokens. A token containing whitespace is likely a
  // multiword command payload (from a quoted string in the shell), not a
  // real path argument. Matching it would kill an unrelated process whose
  // argv merely NAMES a runner path somewhere — e.g., `node "grep
  // /path/to/node_modules/vitest/log" run` (grep is not a runner, but the
  // arg mentions vitest). The fix: only check tokens that don't contain
  // whitespace, since a tokenized path never would (spaces split tokens).
  assert.equal(
    isBatteryInvocation('node "C:/Program Files/my-tool /c/repo/node_modules/vitest/x.log" run'),
    false,
    'node: argument with spaces + runner path must not qualify',
  );
  assert.equal(
    isBatteryInvocation('npx "grep /c/repo/node_modules/vitest/x"'),
    false,
    'npx: argument with spaces + runner path must not qualify',
  );
  // But legitimate, space-free runner paths in args must still qualify.
  assert.equal(isBatteryInvocation('node /c/repo/node_modules/vitest/dist/vitest.mjs run'), true);
  assert.equal(isBatteryInvocation('npx vitest run'), true);
});

// ---------------------------------------------------------------------------
// C1 — the recognised set must cover the harnesses this repo actually runs,
// and the ones it structurally cannot must be DECLARED, not implied.
// ---------------------------------------------------------------------------

test('C1: an orphaned `node --test` worker (npm run test:hooks) is reapable — it is itself a fork pool', () => {
  const v = verdictFor(classifyCensus(), 18001);
  assert.equal(v.verdict, 'reap');
  assert.deepEqual(v.reasons, ['orphaned-unreachable']);
});

test('C1: an orphaned Pester launcher (`pwsh -File scripts/tests/run.ps1`, npm run test:scripts) is reapable', () => {
  const v = verdictFor(classifyCensus(), 19001);
  assert.equal(v.verdict, 'reap');
  assert.deepEqual(v.reasons, ['orphaned-unreachable']);
});

test('C1: an orphaned Playwright CLI (npm run test:e2e) is reapable', () => {
  const v = verdictFor(classifyCensus(), 21001);
  assert.equal(v.verdict, 'reap');
  assert.deepEqual(v.reasons, ['orphaned-unreachable']);
});

test('C1 DECLARED GAP: Invoke-Pester runs in-process, so only the run.ps1 launcher path is recognisable', () => {
  assert.equal(
    isBatteryInvocation('pwsh -ExecutionPolicy Bypass -NoProfile -File C:/repo/scripts/tests/run.ps1'),
    true,
    'the launcher this repo actually spawns IS recognised',
  );
  // Stated, not implied: a Pester run started any other way never appears on
  // a command line as anything but a bare shell, so it cannot be recognised —
  // and the word alone must never be the recogniser (that was exactly C2).
  assert.equal(isBatteryInvocation('pwsh -NoProfile -Command Invoke-Pester -Path scripts/tests'), false);
});

test('C1 DECLARED GAP: pytest IS a recognised invocation but can never enable a kill — python protects first', () => {
  assert.equal(isBatteryInvocation('C:/repo/.venv/Scripts/python.exe -m pytest tests -q'), true);
  assert.equal(isBatteryInvocation('python -m pytest'), true);
  // ...and the module NAME argument is what matters, not a mention.
  assert.equal(isBatteryInvocation('python -m http.server --dir pytest'), false);
  // The gap itself: a real pytest subtree carries python.exe, and classify()
  // evaluates protected:python before the battery gate is ever reached.
  const pytestSubtree = [
    { ...proc(22001, 22000, 'cmd.exe', 5, NOW - 40 * MIN), commandLine: 'cmd.exe /c python -m pytest tests' },
    { ...proc(22002, 22001, 'python.exe', 5, NOW - 40 * MIN), commandLine: 'python -m pytest tests' },
  ];
  const v = verdictFor(classify({ processes: pytestSubtree, priorSamples: {}, protectedPids: [] }, NOW, THRESHOLDS), 22001);
  assert.equal(v.verdict, 'alive');
  assert.deepEqual(v.reasons, ['protected:python']);
});

// ---------------------------------------------------------------------------
// C3 — the producer, and the producer -> consumer contract. Previously every
// runCensus test injected `appendLog: () => {}` and `readPrior: () => ...`, so
// the collector and the log's own key names were never exercised: reinstating
// pass 1's date bug, or renaming `cpuSecondsNow`/`startedAt`, left the suite
// fully green with the collector returning zero rows.
// ---------------------------------------------------------------------------

test(
  'C3: collectProcessSnapshot returns real, plausibly-shaped rows from a real Win32_Process query',
  { skip: process.platform !== 'win32' ? 'Windows-only: Get-CimInstance Win32_Process' : false },
  () => {
    const snapshot = collectProcessSnapshot();
    assert.ok(
      snapshot.length > 0,
      'the collector returned ZERO rows — this is pass 1\u0027s blocking finding, reinstated',
    );
    const self = snapshot.find((p) => p.pid === process.pid);
    assert.ok(self, 'this very process must appear in its own census');
    assert.ok(Number.isFinite(self.startedAt), `startedAt must be a finite epoch, got ${self.startedAt}`);
    assert.ok(
      self.startedAt > Date.parse('2020-01-01T00:00:00Z') && self.startedAt <= Date.now() + 60_000,
      `startedAt must be a plausible epoch-ms, got ${self.startedAt} (${new Date(self.startedAt).toISOString()})`,
    );
    assert.ok(Number.isFinite(self.cpuSeconds) && self.cpuSeconds >= 0);
    assert.ok(typeof self.name === 'string' && self.name.length > 0);
    // The PID-reuse guard and the orphan test both depend on this ordering
    // being real, not merely present.
    const parent = snapshot.find((p) => p.pid === self.ppid);
    if (parent) assert.ok(parent.startedAt <= self.startedAt, 'a real parent cannot start after its child');
  },
);

test('C3: appendCensusLog -> readPriorSamples round trip yields a TRUSTED rate (the real producer, not a stand-in)', () => {
  withTempLog((logPath) => {
    const snapshotAt = (childCpu) => [
      proc(31000, 999, 'WindowsTerminal.exe', 0, NOW - 200 * MIN),
      { ...proc(31001, 31000, 'cmd.exe', 5, NOW - 100 * MIN), commandLine: 'cmd.exe /c npx vitest run' },
      proc(31002, 31001, 'node.exe', childCpu, NOW - 100 * MIN),
    ];
    // Both censuses use the REAL appendCensusLog and the REAL
    // readPriorSamples (neither is injected), so the log's key names are part
    // of what is under test.
    runCensus({ collectSnapshot: () => snapshotAt(100), kill: false, thresholds: THRESHOLDS, now: NOW - 15 * MIN, logPath });
    const { verdicts } = runCensus({ collectSnapshot: () => snapshotAt(101), kill: false, thresholds: THRESHOLDS, now: NOW, logPath });

    const v = verdictFor(verdicts, 31001);
    assert.ok(
      Number.isFinite(v.cpuRatePerMin),
      `expected a finite rate read back from the log, got ${v.cpuRatePerMin} — the producer and consumer disagree about a key name`,
    );
    assert.ok(Math.abs(v.cpuRatePerMin - 1 / 15) < 1e-9, `expected (101-100)/15min, got ${v.cpuRatePerMin}`);
    assert.equal(v.verdict, 'reap');
    assert.deepEqual(v.reasons, ['stalled-rate'], 'the rate detector only works if the round trip does');
  });
});

// ---------------------------------------------------------------------------
// C4 — a kill must be observable, in the log and in the hook's own output
// ---------------------------------------------------------------------------

test('C4: the census log records what was DONE, not only the verdict', () => {
  const appended = [];
  runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: (entry) => appended.push(entry),
    kill: true,
    killReasons: ['orphaned-unreachable'],
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: () => true,
  });
  const roots = appended[0].roots;
  const killedRoot = roots.find((r) => r.rootPid === 3001);
  assert.equal(killedRoot.killed, true, 'the log must record the kill, not just the verdict that preceded it');
  const refusedRoot = roots.find((r) => r.rootPid === 14001);
  assert.equal(refusedRoot.killed, false);
  assert.match(refusedRoot.refusalReason, /python/i, 'and must record WHY a reap candidate was spared');
});

test('C4: a --pre-push kill is announced on stderr (it used to produce zero bytes of output)', () => {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let code;
  try {
    code = runCli(['--pre-push'], {
      runCensusFn: () => ({
        verdicts: [
          {
            rootPid: 501,
            name: 'cmd.exe',
            commandLine: 'cmd.exe /c npx vitest run',
            cpuRatePerMin: null,
            verdict: 'reap',
            reasons: ['orphaned-unreachable'],
          },
        ],
        killed: [501],
        refused: [{ rootPid: 777, reason: 'real OS descendant pid=778 is python.exe' }],
      }),
    });
  } finally {
    process.stderr.write = original;
  }
  const out = chunks.join('');
  assert.equal(code, 0, 'announcing the kill must not start blocking the push');
  assert.match(out, /KILLED stale battery pid=501/);
  assert.match(out, /orphaned-unreachable/);
  assert.match(out, /npx vitest run/, 'a developer must be able to tell WHAT disappeared');
  assert.match(out, /REFUSED pid=777/);
});

test('C4: a pre-push census that killed and refused nothing stays silent', () => {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    runCli(['--pre-push'], { runCensusFn: () => ({ verdicts: [], killed: [], refused: [] }) });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(chunks.join(''), '', 'the common case must not spam every push');
});

// ---------------------------------------------------------------------------
// N10 — a failed/timed-out kill must not read as "never attempted"
// ---------------------------------------------------------------------------

test('N10: a taskkill that fails (killFn returns false) lands in `failed`, never silently in neither bucket', () => {
  const { killed, refused, failed } = runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: () => {},
    kill: true,
    killReasons: ['orphaned-unreachable'],
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: () => false,
  });
  assert.ok(!killed.includes(3001), 'a failed kill must not be reported as killed');
  assert.ok(!refused.some((r) => r.rootPid === 3001), 'a failed kill is not a refusal — it was attempted');
  assert.ok(failed.includes(3001), 'a failed kill must be recorded in its own outcome bucket');
});

test('N10: the census log records a failed kill distinctly, not as an un-acted-on verdict', () => {
  const appended = [];
  runCensus({
    collectSnapshot: () => processes,
    readPrior: () => priorSamples,
    appendLog: (entry) => appended.push(entry),
    kill: true,
    killReasons: ['orphaned-unreachable'],
    thresholds: THRESHOLDS,
    now: NOW,
    killFn: () => false,
  });
  const root = appended[0].roots.find((r) => r.rootPid === 3001);
  assert.equal(root.killed, false, 'the attempt failed, so it must not read as killed');
  assert.equal(root.killFailed, true, 'the log must distinguish "attempted and failed" from "never attempted"');
});

test('N10: a failed pre-push kill is announced on stderr, distinctly from KILLED/REFUSED, and never blocks the push', () => {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let code;
  try {
    code = runCli(['--pre-push'], {
      runCensusFn: () => ({
        verdicts: [
          {
            rootPid: 502,
            name: 'cmd.exe',
            commandLine: 'cmd.exe /c npx vitest run',
            cpuRatePerMin: null,
            verdict: 'reap',
            reasons: ['orphaned-unreachable'],
          },
        ],
        killed: [],
        refused: [],
        failed: [502],
      }),
    });
  } finally {
    process.stderr.write = original;
  }
  const out = chunks.join('');
  assert.equal(code, 0, 'a failed kill must not start blocking the push');
  assert.match(out, /KILL FAILED pid=502/);
  assert.match(out, /npx vitest run/, 'a developer must be able to tell WHAT the failed kill targeted');
  assert.doesNotMatch(out, /KILLED stale battery pid=502/, 'a failed kill must never be reported as a success');
});

// ---------------------------------------------------------------------------
// C5 — the killer is the one spawn on the hook path, and it must be bounded
// ---------------------------------------------------------------------------

test('C5: killTree bounds its taskkill spawn with a timeout', () => {
  let seen = null;
  killTree(4242, {
    windows: true,
    spawn: (cmd, args, opts) => {
      seen = { cmd, args, opts };
      return { status: 0 };
    },
  });
  assert.equal(seen.cmd, 'taskkill');
  assert.deepEqual(seen.args, ['/PID', '4242', '/T', '/F']);
  assert.ok(
    Number.isFinite(seen.opts.timeout) && seen.opts.timeout > 0,
    `expected a finite spawn timeout so a wedged taskkill cannot hang git push, got ${seen.opts.timeout}`,
  );
});

test('C5: a taskkill that times out reports false, so the root is never recorded as killed', () => {
  const timedOut = { error: Object.assign(new Error('spawnSync taskkill ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null };
  assert.equal(killTree(4242, { windows: true, spawn: () => timedOut }), false);
});

// ---------------------------------------------------------------------------
// C6 — the tail window is sized against the trust window, not a round number
// ---------------------------------------------------------------------------

// Measured live on a 415-root box (PR #3063 review pass 2): the flat 2MB the
// first version used therefore held only NINE entries.
const MEASURED_CENSUS_ENTRY_BYTES = 214_013;

test('C6: tailBytesFor sizes the window against the trust window, not a round number', () => {
  const bytes = tailBytesFor(10 * MIN);
  const entries = bytes / MEASURED_CENSUS_ENTRY_BYTES;
  assert.ok(entries >= 20, `expected >= 20 measured-size entries of window, got ${entries.toFixed(1)}`);
  assert.ok(tailBytesFor(20 * MIN) > bytes, 'a wider trust window must widen the tail with it');
});

test('C6: with realistically-sized entries, a 10-minute-old sample is still inside the default window', () => {
  withTempLog((logPath) => {
    const rootPid = 77001;
    // 21 entries at one every 30s — the fastest cadence worth sizing for, and
    // roughly what E104's own criterion (2) produces while an operator pokes
    // at `npm run doctor`. The oldest sits exactly at the 10-minute bar.
    const lines = [];
    for (let i = 20; i >= 0; i -= 1) {
      const entry = { ts: NOW - i * 30_000, pad: '', roots: [{ rootPid, cpuSecondsNow: 100 + (20 - i), startedAt: 500 }] };
      entry.pad = 'x'.repeat(Math.max(1, MEASURED_CENSUS_ENTRY_BYTES - JSON.stringify(entry).length));
      lines.push(JSON.stringify(entry));
    }
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

    const samples = readPriorSamples(logPath, { now: NOW, minSampleAgeMs: 10 * MIN });
    assert.ok(samples[rootPid], 'expected a sample for the root');
    const ageMin = (NOW - samples[rootPid].sampledAt) / MIN;
    assert.ok(
      NOW - samples[rootPid].sampledAt >= 10 * MIN,
      `expected a TRUSTED (>=10 min old) sample to still be inside the window; got one ${ageMin.toFixed(1)} min old — the window is too small and stalled-rate goes dark`,
    );
  });
});

// ---------------------------------------------------------------------------
// N3 / N5 — retention, and the partial-write concatenation
// ---------------------------------------------------------------------------

test('N3: the census log rolls to exactly one previous generation once past its cap', () => {
  withTempLog((logPath) => {
    appendCensusLog({ ts: 1, roots: [{ rootPid: 1, cpuSecondsNow: 1, startedAt: 1 }] }, logPath, { maxBytes: 10 });
    assert.equal(existsSync(`${logPath}.1`), false, 'nothing to roll on the first write');
    appendCensusLog({ ts: 2, roots: [{ rootPid: 2, cpuSecondsNow: 2, startedAt: 1 }] }, logPath, { maxBytes: 10 });
    assert.equal(existsSync(`${logPath}.1`), true, 'the previous generation is retained for the governor dataset, not deleted');
    const current = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(current.length, 1, 'the live log restarts at the rolled boundary');
    assert.equal(JSON.parse(current[0]).ts, 2);
  });
});

test('N5: an entry appended after a partial write is not concatenated onto the fragment', () => {
  withTempLog((logPath) => {
    // A census killed mid-appendFileSync leaves a newline-less fragment.
    writeFileSync(logPath, '{"ts":1,"roots":[{"rootPid":1,"cpuSec', 'utf8');
    appendCensusLog({ ts: NOW - 30 * MIN, roots: [{ rootPid: 4242, cpuSecondsNow: 7, startedAt: 500 }] }, logPath);
    const samples = readPriorSamples(logPath, { now: NOW, minSampleAgeMs: 10 * MIN });
    assert.ok(samples[4242], 'the entry written AFTER a fragment must still parse — it used to be lost too');
    assert.equal(samples[4242].cpuSeconds, 7);
  });
});

// ---------------------------------------------------------------------------
// P1 — whitespace discriminator fixes (Finding 1, PR #3063 review pass 4)
// ---------------------------------------------------------------------------

test('P1a: node with space-free inline source (node -e) must not match runner paths inside the payload', () => {
  // `node -e 'require(...node_modules/vitest...'` — the runner path is
  // quoted INSIDE the -e payload, not an argv token. Must not qualify.
  assert.equal(
    isBatteryInvocation(
      "node -e require('/c/repo/node_modules/vitest/dist/index.js')"
    ),
    false,
    'node -e with an embedded path is not a runner invocation'
  );
});

test('P1b: npx with grep flag and a runner name (npx eslint --fix vitest)', () => {
  // "vitest" is the 3rd argument (a file/pattern to lint), not the target package.
  // Must not qualify.
  assert.equal(
    isBatteryInvocation('npx eslint --fix vitest'),
    false,
    'npx: runner name in a later position (not the package) must not qualify'
  );
});

test('P1c: npx rimraf on a runner path directory', () => {
  // Deleting a directory path that contains a runner name is not running a runner.
  // Must not qualify.
  assert.equal(
    isBatteryInvocation('npx rimraf /c/repo/node_modules/vitest/'),
    false,
    'npx rimraf with a path is not a runner invocation'
  );
});

test('P1d: cmd with shell payload mentioning a runner (cmd /c "node --version && tail vitest.log")', () => {
  // The /c payload is a compound shell command; `node --version` is not a runner invocation.
  // Must not qualify.
  assert.equal(
    isBatteryInvocation('cmd /c "node --version && tail /c/repo/node_modules/vitest/x.log"'),
    false,
    'cmd /c with a non-battery shell command must not qualify'
  );
});

test('P1e: node with genuine battery on spaced checkout path', () => {
  // On a Windows path with spaces: `node "C:\Users\John Smith\repo\node_modules\vitest\vitest.mjs" run`
  // After tokenization, the quoted path becomes a single token WITH spaces.
  // The fix must anchor on the actual file name at the end, not reject all spaced tokens.
  assert.equal(
    isBatteryInvocation('node "C:\\Users\\John Smith\\repo\\node_modules\\vitest\\vitest.mjs" run'),
    true,
    'node with a spaced path to vitest.mjs MUST qualify'
  );
});

test('P1f: npx vitest on spaced checkout', () => {
  // Same shape: npx (the exe) on a normal spaced path. The arg "vitest" has no spaces.
  // Must still qualify because "vitest" is the bare package name.
  assert.equal(
    isBatteryInvocation('npx vitest run'),
    true,
    'npx vitest is always a runner invocation, regardless of path spaces'
  );
});

test('P1g: Playwright cli.js on spaced checkout', () => {
  // NOTE (review pass 5, Q1): this comment previously asserted "Playwright's
  // actual entry: node C:/repo/node_modules/playwright/cli.js test" as if
  // verified — it was not. A real `npm run test:e2e` capture (Q1's own
  // evidence) shows cli.js DOES appear as a real root command line, but
  // reached via the npm .bin shim (`node_modules\.bin\\..\@playwright\test\cli.js`,
  // see Q1 below) and its actual per-test WORKER children run a DIFFERENT
  // entry point entirely: node_modules/playwright/lib/worker/workerProcessEntry.js
  // (also pinned below). This test still stands on its own narrower claim —
  // a spaced path to a bare, unwrapped cli.js token must resolve — but "the"
  // actual entry is now correctly plural, not this one file.
  assert.equal(
    isBatteryInvocation('node "C:\\Users\\Code Reviewer\\castwright\\node_modules\\playwright\\cli.js" test'),
    true,
    'Playwright CLI on a spaced path MUST qualify'
  );
});

test('P1h: run-hooks-tests.mjs on spaced checkout', () => {
  // `node C:/repo/scripts/run-hooks-tests.mjs`
  // With spaces in the path, must still recognize the .mjs file.
  assert.equal(
    isBatteryInvocation('node "C:\\Users\\John Smith\\castwright\\scripts\\run-hooks-tests.mjs"'),
    true,
    'run-hooks-tests.mjs on a spaced path MUST qualify'
  );
});

// ---------------------------------------------------------------------------
// Q1 (review pass 5): the reaper had NEVER recognised a real battery on this
// box. Mined from this tool's own census log, logs/reaper-census.jsonl:
// 5,620 root records across 16 real censuses, exactly ONE recognised (a
// pytest shape that can never enable a kill). Confirmed live for this fix by
// spawning real `npm test` / `npm run test:e2e` batteries under this repo's
// own npm and capturing Get-CimInstance Win32_Process mid-run — the strings
// below are that capture, generalised only by swapping the real worktree
// path for "C:\repo". npm's Windows `.bin` shim does not expand to a clean
// `node_modules/vitest/vitest.mjs` path: it inserts a `.bin\` segment and a
// `..` hop, WITH A DOUBLED BACKSLASH, which neither existing pattern could
// ever see through (no "node_modules/vitest/" substring, and it doesn't end
// at ".bin/vitest").
// ---------------------------------------------------------------------------

test('Q1: real npm .bin shim expansion of `npm test` (vitest) now qualifies', () => {
  // Verbatim shape (drive/worktree path genericised) captured live via
  // Get-CimInstance Win32_Process from a real `npm test` supervisor:
  //   "node"   "<repo>\node_modules\.bin\\..\vitest\vitest.mjs" run
  assert.equal(
    isBatteryInvocation('node "C:\\repo\\node_modules\\.bin\\\\..\\vitest\\vitest.mjs" run'),
    true,
    'a real npm .bin shim expansion of `vitest run` MUST qualify'
  );
});

test('Q1: real npm .bin shim expansion of `npm run test:e2e` (Playwright cli.js) now qualifies', () => {
  // Verbatim shape (drive/worktree path genericised) captured live from a
  // real `npm run test:e2e` supervisor:
  //   "node"   "<repo>\node_modules\.bin\\..\@playwright\test\cli.js" test ...
  assert.equal(
    isBatteryInvocation(
      'node "C:\\repo\\node_modules\\.bin\\\\..\\@playwright\\test\\cli.js" test --project=chromium',
    ),
    true,
    'a real npm .bin shim expansion of Playwright\'s cli.js MUST qualify',
  );
});

test('Q1: Playwright\'s real worker entry (workerProcessEntry.js) is independently recognised', () => {
  // Captured live as a DIRECT child of the cli.js process above, with no
  // shell or cli.js wrapper in between:
  //   "node.exe" C:\repo\node_modules\playwright\lib\worker\workerProcessEntry.js
  // If the cli.js root dies (or is reaped) before its workers exit, an
  // orphaned worker subtree would carry no recognised member at all without
  // this — cli.js alone is not enough.
  assert.equal(
    isBatteryInvocation('node C:\\repo\\node_modules\\playwright\\lib\\worker\\workerProcessEntry.js'),
    true,
    'Playwright\'s workerProcessEntry.js MUST independently qualify as a battery member',
  );
});

test('Q3: npx with a space-separated value flag before the runner (`npx --registry <url> vitest run`)', () => {
  // The value token after --registry is NOT the package/binary to run —
  // it must be skipped, not mistaken for it.
  assert.equal(
    isBatteryInvocation('npx --registry https://registry.example.com vitest run'),
    true,
    'npx --registry <url> vitest run MUST still qualify on the real runner arg',
  );
});

test('Q3: npx with -p <package> before the runner (`npx -p vitest@4 vitest run`)', () => {
  assert.equal(
    isBatteryInvocation('npx -p vitest@4 vitest run'),
    true,
    'npx -p vitest@4 vitest run MUST still qualify on the real runner arg',
  );
});
