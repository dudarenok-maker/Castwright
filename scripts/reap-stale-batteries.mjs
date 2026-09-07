#!/usr/bin/env node
// scripts/reap-stale-batteries.mjs — Part 3 of ops-2997
// (docs/superpowers/specs/2026-09-05-commit-gate-rebalance-design.md), closing
// #3047 (ops-71). An earlier draft left this as a manual, report-only CLI
// nothing ever called, while the design's own risk table credited it with
// automatic cleanup. This file IS that automatic cleanup: `npm run doctor`
// (report-only), `npm run doctor -- --kill` (the wider manual path), and the
// `.husky/pre-push` census wiring (kill orphans only, never blocks the push).
//
// `classify(snapshot, now, thresholds)` is a pure function — the testable
// seam the ticket calls out. Everything that touches the OS (spawning
// PowerShell, reading/writing the census log, killing a tree) lives in the
// thin collection/report layer below it and is exercised via dependency
// injection in scripts/tests/reap-stale-batteries.test.mjs, never by
// mocking classify() itself.
//
// TWO INDEPENDENT TESTS, both required (neither alone is sufficient — see
// the issue's own table):
//   1. Two-sample subtree CPU rate — catches genuinely stalled work, but
//      misses busy work that cannot land (an orphan can still burn CPU).
//   2. Reachability (top ancestor gone AND no git.exe anywhere in the
//      subtree) — catches doomed orphans regardless of how busy they are,
//      but misses a live-parented battery that is truly wedged.
// The "two samples" for test 1 are NOT two queries in one invocation (the
// hook budget is ONE Win32_Process query, ~300ms, no pool) — they are THIS
// census and the immediately-preceding one, read back from the append-only
// log. That is also why the log records each root's command line: it is the
// dataset, not a debugging aid (see the design doc's "Deferred work" section).

import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');
export const CENSUS_LOG_PATH = resolve(REPO_ROOT, 'logs', 'reaper-census.jsonl');

export const DEFAULT_THRESHOLDS = {
  // Subtree CPU-s/min at or under which a subtree counts as stalled. A
  // healthy vitest worker subtree burns 30-100 CPU-s/min; a healthy
  // supervisor alone idles around ~0.9 (see the design doc's own figures) —
  // this is judged against the SUBTREE sum, never the root process alone.
  deadRateCpuSecPerMin: 2,
  // Refuse to trust a rate computed over too short a window — noise, not
  // signal. Mirrors the "under 2 after 10+ minutes is dead" framing.
  minSampleAgeMs: 10 * 60 * 1000,
};

const NEVER_REAP_NAME_RE = /^python(?:\.exe)?$/i;
const GIT_NAME_RE = /^git(?:\.exe)?$/i;

// A "battery" is a supervisor chain that alternates node -> cmd -> node (the
// design doc's own framing) or the POSIX/PowerShell equivalents. Climbing
// stops the moment we hit a PARENT that is NOT one of these — an IDE, a
// terminal host, explorer.exe, a service host — because that parent is the
// battery's OWNER, not part of it. Without this bound, resolveRoot would
// walk every process on the box up through services.exe/wininit.exe to
// System (pid 4), merging every unrelated battery on the machine into one
// giant subtree (a git.exe anywhere would then "protect" an unrelated
// orphaned vitest tree, and CPU sums would be meaningless).
const SUPERVISOR_NAME_RE = /^(node|cmd|sh|bash|powershell|pwsh)(?:\.exe)?$/i;

// A subtree is only EVER a reap candidate if some member's command line
// carries a real test-runner marker — the actual repo invocations bottom out
// in one of these (npm run test[:server] -> vitest, npm run test:sidecar ->
// `python -m pytest`, npm run test:scripts -> Invoke-Pester). This is an
// ALLOWLIST of what may be killed, evaluated BEFORE and independently of the
// python/git-overlap/self-ancestry protections below (defense in depth: a
// battery-shaped subtree can still be protected by those). Without this gate,
// classify() reasons over every Win32_Process row on the box — verified live
// (PR #3063 review) to reach `npm run dev`, a sibling worktree's running
// battery, Ollama, Steam, and OS processes once the date-parsing bug (see
// collectProcessSnapshot below) is fixed and the collector stops returning [].
const BATTERY_COMMAND_RE = /\b(vitest|pytest|invoke-pester)\b/i;

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

/**
 * Walk pid -> ppid links inside `byPid`, but ONLY through supervisor-shaped
 * parents (see SUPERVISOR_NAME_RE), to the topmost process that is still
 * part of the same battery. Also guards against PID reuse (a "parent"
 * started AFTER the child it supposedly spawned cannot really be its
 * parent) and cycles.
 *
 * Returns { topPid, parentReachable }. `parentReachable` is true when the
 * climb stopped at a live, non-battery-shaped OWNER process (a terminal, an
 * IDE, a shell) that is still present in this snapshot — that owner being
 * alive is exactly what "not orphaned" means. It is false when the climb's
 * final link points at a ppid this snapshot does not contain at all, or at
 * a recycled pid — either way, "the top ancestor is gone".
 */
function resolveRoot(pid, byPid) {
  const visited = new Set();
  let top = byPid.get(pid);
  while (true) {
    visited.add(top.pid);
    const parent = byPid.get(top.ppid);
    if (!parent) {
      return { topPid: top.pid, parentReachable: top.ppid === top.pid };
    }
    if (parent.startedAt > top.startedAt || visited.has(parent.pid)) {
      // PID reuse (parent "created" after the child it supposedly spawned)
      // or a cycle (corrupt/adversarial input) — treat the link as broken.
      return { topPid: top.pid, parentReachable: false };
    }
    if (!SUPERVISOR_NAME_RE.test(parent.name)) {
      // A live, non-battery owner — the climb ends here, and its mere
      // presence means this subtree is reachable (not orphaned).
      return { topPid: top.pid, parentReachable: true };
    }
    top = parent;
  }
}

/** Group every process in `processes` into subtrees keyed by their resolved
 *  root pid, alongside whether that root's own parent is reachable. */
function buildSubtrees(processes) {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const rootInfoByPid = new Map();
  for (const p of processes) {
    if (!rootInfoByPid.has(p.pid)) {
      rootInfoByPid.set(p.pid, resolveRoot(p.pid, byPid));
    }
  }
  const subtrees = new Map(); // topPid -> { root, members: [], parentReachable }
  for (const p of processes) {
    const { topPid, parentReachable } = rootInfoByPid.get(p.pid);
    if (!subtrees.has(topPid)) {
      subtrees.set(topPid, { root: byPid.get(topPid), members: [], parentReachable });
    }
    subtrees.get(topPid).members.push(p);
  }
  return [...subtrees.values()];
}

/**
 * @param {object} snapshot
 * @param {Array<{pid:number, ppid:number, name:string, commandLine:string,
 *   cpuSeconds:number, startedAt:number}>} snapshot.processes - every
 *   process this census's ONE query saw.
 * @param {Record<number,{cpuSeconds:number, sampledAt:number, startedAt:number}>}
 *   [snapshot.priorSamples] - the previous census's entry for a given root
 *   pid, keyed by that pid. `startedAt` guards against PID reuse: a prior
 *   sample only counts as the SAME battery if the current root's own
 *   startedAt matches it.
 * @param {Iterable<number>} [snapshot.protectedPids] - the caller's own
 *   ancestor chain (this script's own pid, its parent, ...). Never reapable.
 * @param {number} now - epoch ms this census was taken at.
 * @param {object} thresholds - see DEFAULT_THRESHOLDS.
 * @returns {Array<object>} one verdict per subtree root, always including
 *   protected/alive subtrees (the census log wants every root's command
 *   line, not just reap candidates).
 */
export function classify(snapshot, now, thresholds) {
  const processes = snapshot.processes ?? [];
  const priorSamples = snapshot.priorSamples ?? {};
  const protectedPids = new Set(snapshot.protectedPids ?? []);

  const subtrees = buildSubtrees(processes);

  return subtrees.map(({ root, members, parentReachable }) => {
    const memberPids = members.map((m) => m.pid);
    const cpuSecondsNow = members.reduce((sum, m) => sum + m.cpuSeconds, 0);
    const hasPython = members.some((m) => NEVER_REAP_NAME_RE.test(m.name));
    const hasGit = members.some((m) => GIT_NAME_RE.test(m.name));
    const overlapsProtected = memberPids.some((pid) => protectedPids.has(pid));
    const isBatteryCandidate = members.some((m) => BATTERY_COMMAND_RE.test(m.commandLine));

    const prior = priorSamples[root.pid];
    let cpuRatePerMin = null;
    if (prior && prior.startedAt === root.startedAt) {
      const elapsedMs = now - prior.sampledAt;
      if (elapsedMs >= thresholds.minSampleAgeMs) {
        const deltaCpu = Math.max(0, cpuSecondsNow - prior.cpuSeconds);
        cpuRatePerMin = deltaCpu / (elapsedMs / 60000);
      }
    }

    const orphaned = !parentReachable;

    let verdict = 'alive';
    let reasons = [];

    if (hasPython) {
      reasons = ['protected:python'];
    } else if (overlapsProtected) {
      reasons = ['protected:self-ancestry'];
    } else if (hasGit) {
      // "Never touch anything overlapping a live git commit's subtree" —
      // blanket, independent of either test below.
      reasons = ['protected:git-overlap'];
    } else if (isBatteryCandidate) {
      // Nothing below this line can fire for a subtree that never carried a
      // test-runner marker — see BATTERY_COMMAND_RE's comment. An orphaned,
      // idle `steam.exe` and a busy, live-parented `npm run dev` both fall
      // through with verdict 'alive', reasons [], regardless of how they'd
      // otherwise score.
      if (cpuRatePerMin !== null && cpuRatePerMin <= thresholds.deadRateCpuSecPerMin) {
        reasons.push('stalled-rate');
      }
      if (orphaned) {
        reasons.push('orphaned-unreachable');
      }
      if (reasons.length > 0) verdict = 'reap';
    }

    return {
      rootPid: root.pid,
      name: root.name,
      commandLine: root.commandLine,
      subtreePids: memberPids,
      cpuSecondsNow,
      cpuRatePerMin,
      verdict,
      reasons,
    };
  });
}

// ---------------------------------------------------------------------------
// Thin collection layer — everything below touches the OS or the filesystem.
// ---------------------------------------------------------------------------

const isWindows = process.platform === 'win32';

/** Map raw JSON rows from `collectProcessSnapshot`'s PowerShell query into the
 *  process shape `classify()` expects. Pure and exported so this layer has a
 *  unit-testable seam without a real Windows box — this is exactly the layer
 *  the date-parsing bug (see `CreationEpochMs` below) lived in with zero test
 *  coverage: the old fixture invented its own already-normalised row shape
 *  instead of a shape `Get-CimInstance` + `ConvertTo-Json` actually emits.
 *  Filters out any row missing a required field rather than throwing. */
export function rowsToProcesses(rows) {
  return rows
    .map((row) => {
      if (typeof row.CreationEpochMs !== 'number' || !Number.isFinite(row.CreationEpochMs)) return null;
      if (row.ProcessId == null || row.ParentProcessId == null) return null;
      return {
        pid: row.ProcessId,
        ppid: row.ParentProcessId,
        name: row.Name ?? '',
        commandLine: row.CommandLine ?? '',
        cpuSeconds: Number(row.CpuSeconds) || 0,
        startedAt: row.CreationEpochMs,
      };
    })
    .filter(Boolean);
}

/** One Win32_Process query — the entire OS-touching cost of a pre-push
 *  census (~300ms). Deliberately does NOT spawn a pool: exactly one
 *  `powershell` child. Returns [] (never throws) on a non-Windows host or
 *  any PowerShell failure — a census that can't run must never block a push.
 *
 *  `CreationEpochMs` is computed INSIDE PowerShell via `[DateTimeOffset]` and
 *  cast to `[long]` before `ConvertTo-Json` ever sees it, rather than parsing
 *  `CreationDate` on the Node side. `Get-CimInstance`'s `CreationDate` is a
 *  real `System.DateTime` and its `ConvertTo-Json` serialisation is version-
 *  dependent — `/Date(1788727332170)/` on Windows PowerShell 5.1 (what
 *  `spawnSync('powershell', ...)` actually invokes) vs. an ISO-8601 string on
 *  pwsh 7 — and a Node-side parser tuned for one silently drops every row
 *  under the other. `[long]` always serialises as a plain JSON number on
 *  both, sidestepping the ambiguity rather than chasing both formats. */
export function collectProcessSnapshot() {
  if (!isWindows) return [];
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | " +
        "Select-Object ProcessId,ParentProcessId,Name,CommandLine," +
        "@{N='CreationEpochMs';E={ if ($_.CreationDate) { [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null } }}," +
        "@{N='CpuSeconds';E={([double]$_.UserModeTime + [double]$_.KernelModeTime)/1e7}} | " +
        'ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  if (result.error || result.status !== 0 || !result.stdout) return [];
  let rows;
  try {
    const parsed = JSON.parse(result.stdout);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  return rowsToProcesses(rows);
}

/** This process's own ancestor pids, resolved from `processes` — never
 *  reapable, mirroring the design doc's "or the caller's own ancestor
 *  chain". Bounded walk; tolerant of a chain that runs off the snapshot. */
export function ownAncestryPids(processes, selfPid = process.pid) {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const out = [selfPid];
  let current = byPid.get(selfPid);
  let hops = 0;
  while (current && hops < 64) {
    const parent = byPid.get(current.ppid);
    if (!parent || out.includes(parent.pid)) break;
    out.push(parent.pid);
    current = parent;
    hops += 1;
  }
  return out;
}

// Bound for readPriorSamples' tail read. Measured live (PR #3063 review):
// ~200KB per census entry on a real 416-process box, and the log is
// append-only and never rotated by this script — re-parsing the WHOLE file
// every push grows unboundedly and blows the hook's "~300ms, no pool"
// budget. 2MB covers roughly the last ten entries, comfortably more than any
// realistic minSampleAgeMs lookback needs (the default is 10 minutes; even a
// push every couple of minutes stays inside this window). The full log still
// grows unboundedly ON DISK for the deferred concurrency-governor dataset
// (see the top-of-file comment) — this only bounds what gets loaded into
// memory and parsed on the hot path; older entries are still there for that
// dataset, just not re-read on every push.
const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;

/** Read the trailing `maxBytes` of `path` as UTF-8 text without loading the
 *  whole file. A read that starts partway through the file may begin
 *  mid-line — callers tolerate that line failing to parse rather than
 *  needing it stripped explicitly. */
function readTailText(path, maxBytes) {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length === 0) return '';
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Read prior census samples per root pid from the JSONL census log, bounded
 *  to a trailing window (see DEFAULT_TAIL_BYTES) rather than the whole file.
 *  Missing/corrupt log -> {} (a fresh log has no history yet, which is
 *  exactly the "insufficient data" case classify() already handles by
 *  leaving cpuRatePerMin null).
 *
 *  Per root pid, prefers the most recent sample that is ALREADY at least
 *  `minSampleAgeMs` old relative to `now`, rather than simply the newest
 *  sample regardless of age. Without this, two pushes closer together than
 *  the trust window always compare against a too-recent sample and the rate
 *  signal goes dark for every root, silently, exactly when the box is
 *  busiest (rapid consecutive pushes). Falls back to the newest sample when
 *  none is old enough yet — classify()'s own age check then leaves the rate
 *  untrusted, same as before this fix. */
export function readPriorSamples(
  logPath = CENSUS_LOG_PATH,
  { now = Date.now(), minSampleAgeMs = DEFAULT_THRESHOLDS.minSampleAgeMs, tailBytes = DEFAULT_TAIL_BYTES } = {},
) {
  if (!existsSync(logPath)) return {};
  let text;
  try {
    text = readTailText(logPath, tailBytes);
  } catch {
    return {};
  }
  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  const samplesByRoot = new Map();
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Includes the tail read's own possibly-truncated first line — expected,
      // not an error.
      continue;
    }
    for (const root of entry.roots ?? []) {
      if (!samplesByRoot.has(root.rootPid)) samplesByRoot.set(root.rootPid, []);
      samplesByRoot.get(root.rootPid).push({
        cpuSeconds: root.cpuSecondsNow,
        sampledAt: entry.ts,
        startedAt: root.startedAt,
      });
    }
  }

  const priorSamples = {};
  for (const [rootPid, samples] of samplesByRoot) {
    samples.sort((a, b) => b.sampledAt - a.sampledAt);
    const trusted = samples.find((s) => now - s.sampledAt >= minSampleAgeMs);
    priorSamples[rootPid] = trusted ?? samples[0];
  }
  return priorSamples;
}

/** Append one census entry — every root's command line, per the ticket
 *  ("the 2026-09-05 census omitted it"). */
export function appendCensusLog(entry, logPath = CENSUS_LOG_PATH) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Kill one subtree by its root pid. Windows-only (matches this repo's
 *  primary platform and the prior art in scripts/stop-app.mjs); a no-op
 *  elsewhere rather than a throw. */
export function killTree(pid) {
  if (!isWindows) return false;
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

/**
 * The full, unbounded OS descendant closure of `rootPid` — every process
 * reachable by following forward `ppid` links, with NO name filtering and NO
 * supervisor-shape bound. This models exactly what `taskkill /PID rootPid /T
 * /F` actually reaches, which is NOT the same set as `classify()`'s
 * supervisor-bounded subtree: `resolveRoot`/`buildSubtrees` climb UPWARD
 * through supervisor-shaped parents only, so a non-supervisor-shaped process
 * sitting between `rootPid` and one of its real OS descendants breaks that
 * descendant into its OWN subtree in classify()'s eyes — yet `taskkill /T`
 * from `rootPid` still reaches straight through it. Verified live (PR #3063
 * review): 286 processes classify() marked 'alive' — including python.exe in
 * its OWN 'protected:python' subtree — sat inside some reap candidate's real
 * `/T` reach on that box. Includes `rootPid` itself; callers skip it when
 * checking for collateral. */
export function computeOsDescendants(rootPid, allProcesses) {
  const childrenByPpid = new Map();
  for (const p of allProcesses) {
    if (!childrenByPpid.has(p.ppid)) childrenByPpid.set(p.ppid, []);
    childrenByPpid.get(p.ppid).push(p.pid);
  }
  const visited = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const childPid of childrenByPpid.get(current) ?? []) {
      if (visited.has(childPid)) continue; // cycle/PID-reuse-shaped guard
      visited.add(childPid);
      queue.push(childPid);
    }
  }
  return visited;
}

/**
 * Refuses a kill when `rootPid`'s real OS descendant closure (computed via
 * `computeOsDescendants`, NOT `classify()`'s subtree) contains any pid that
 * is python.exe, git.exe, in the caller's own ancestry, or belongs — per
 * `classify()`'s own subtree grouping — to a DIFFERENT subtree whose verdict
 * is not 'reap'. That last case is the general form of the structural bug:
 * the kill would collaterally reach into something classify() itself
 * considers alive or protected, just filed under a different root because an
 * intervening non-supervisor-shaped process broke the upward climb. Returns
 * a human-readable reason string, or null when the kill is safe to perform.
 */
function findKillRefusalReason(rootPid, processes, protectedPids, pidToRoot, rootVerdict) {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const descendants = computeOsDescendants(rootPid, processes);
  for (const pid of descendants) {
    if (pid === rootPid) continue;
    const proc = byPid.get(pid);
    if (proc && NEVER_REAP_NAME_RE.test(proc.name)) {
      return `real OS descendant pid=${pid} (${proc.name}) is python.exe`;
    }
    if (proc && GIT_NAME_RE.test(proc.name)) {
      return `real OS descendant pid=${pid} (${proc.name}) is git.exe`;
    }
    if (protectedPids.has(pid)) {
      return `real OS descendant pid=${pid} is in the caller's own ancestry`;
    }
    const owningRoot = pidToRoot.get(pid);
    if (owningRoot !== undefined && owningRoot !== rootPid && rootVerdict.get(owningRoot) !== 'reap') {
      return `real OS descendant pid=${pid} belongs to subtree rootPid=${owningRoot} (verdict=${rootVerdict.get(owningRoot)})`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orchestration — the pre-push census and `npm run doctor`.
// ---------------------------------------------------------------------------

/**
 * Runs one census, appends it to the log, and (when `kill` is true) reaps
 * qualifying subtrees. `killReasons` narrows WHICH reap reasons this caller
 * is allowed to act on — the pre-push wiring passes only
 * ['orphaned-unreachable'] ("kill only provably-orphaned trees"); the wider
 * `--kill` manual path passes both. Before each kill, `findKillRefusalReason`
 * re-checks the root's real OS descendant closure (not classify()'s subtree)
 * and refuses rather than kills when that closure reaches anything protected
 * or alive — see its own doc comment. Refused roots land in `refused`
 * (`{rootPid, reason}`), never in `killed`.
 *
 * Every argument the OS/filesystem touches is injectable so tests never
 * need a real Windows box or a real stale process.
 */
export function runCensus({
  collectSnapshot = collectProcessSnapshot,
  readPrior = readPriorSamples,
  appendLog = appendCensusLog,
  kill = false,
  killReasons = ['orphaned-unreachable', 'stalled-rate'],
  thresholds = DEFAULT_THRESHOLDS,
  now = Date.now(),
  killFn = killTree,
  logPath = CENSUS_LOG_PATH,
} = {}) {
  const processes = collectSnapshot();
  const priorSamples = readPrior(logPath, { now, minSampleAgeMs: thresholds.minSampleAgeMs });
  const protectedPidsList = ownAncestryPids(processes);
  const protectedPids = new Set(protectedPidsList);

  const verdicts = classify({ processes, priorSamples, protectedPids: protectedPidsList }, now, thresholds);

  appendLog(
    {
      ts: now,
      roots: verdicts.map((v) => ({
        rootPid: v.rootPid,
        name: v.name,
        commandLine: v.commandLine,
        startedAt: processes.find((p) => p.pid === v.rootPid)?.startedAt ?? null,
        cpuSecondsNow: v.cpuSecondsNow,
        cpuRatePerMin: v.cpuRatePerMin,
        verdict: v.verdict,
        reasons: v.reasons,
      })),
    },
    logPath,
  );

  const killed = [];
  const refused = [];
  if (kill) {
    const pidToRoot = new Map();
    const rootVerdict = new Map();
    for (const v of verdicts) {
      rootVerdict.set(v.rootPid, v.verdict);
      for (const pid of v.subtreePids) pidToRoot.set(pid, v.rootPid);
    }

    for (const v of verdicts) {
      if (v.verdict !== 'reap') continue;
      if (!v.reasons.some((r) => killReasons.includes(r))) continue;
      const refusalReason = findKillRefusalReason(v.rootPid, processes, protectedPids, pidToRoot, rootVerdict);
      if (refusalReason) {
        refused.push({ rootPid: v.rootPid, reason: refusalReason });
        continue;
      }
      if (killFn(v.rootPid)) killed.push(v.rootPid);
    }
  }

  return { verdicts, killed, refused };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * The CLI body, factored out from `process.exit` so it's unit-testable: it
 * RETURNS an exit code instead of calling `process.exit` itself. This is
 * what proves "never blocks the push" as a real test rather than an
 * assertion about source text — pass a `runCensusFn` that throws and
 * confirm this still returns 0.
 */
export function runCli(args, { runCensusFn = runCensus } = {}) {
  const wideKill = args.includes('--kill');
  const isPrePush = args.includes('--pre-push');

  try {
    const { verdicts, killed, refused } = runCensusFn({
      kill: isPrePush || wideKill,
      // Pre-push is the narrow, never-blocking path: only kill what is
      // PROVABLY orphaned (dead parent), never a merely-slow subtree that
      // might still land. `--kill` (npm run doctor -- --kill) is the wider,
      // human-invoked path and may also reap stalled-but-live-parented work.
      killReasons: isPrePush && !wideKill ? ['orphaned-unreachable'] : ['orphaned-unreachable', 'stalled-rate'],
    });

    if (!isPrePush) {
      for (const v of verdicts) {
        const killedTag = killed.includes(v.rootPid) ? ' [KILLED]' : '';
        const refusedEntry = (refused ?? []).find((r) => r.rootPid === v.rootPid);
        const refusedTag = refusedEntry ? ` [REFUSED: ${refusedEntry.reason}]` : '';
        process.stdout.write(
          `${v.verdict.padEnd(9)} pid=${v.rootPid} rate=${v.cpuRatePerMin === null ? 'n/a' : v.cpuRatePerMin.toFixed(2)} reasons=${v.reasons.join(',') || '-'}${killedTag}${refusedTag} :: ${v.commandLine}\n`,
        );
      }
    }
  } catch (err) {
    // The pre-push invocation must NEVER block the push — report and move
    // on regardless of cause.
    process.stderr.write(`reap-stale-batteries: census failed, not blocking: ${err?.message ?? err}\n`);
  }
  // Never a nonzero exit from the pre-push path; the manual `doctor` path
  // has nothing worth failing CI on either (it's advisory).
  return 0;
}

if (isDirectlyInvoked(import.meta.url)) {
  // Never process.exit() here: `doctor`'s report-only output can be several
  // lines, and process.exit() truncates pending async stdout writes on
  // POSIX (see scripts/lib/is-main-module.mjs's own warning). Set
  // exitCode and let the event loop drain naturally instead.
  process.exitCode = runCli(process.argv.slice(2));
}
