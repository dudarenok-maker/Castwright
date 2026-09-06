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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
    } else {
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

/** Convert a WMI/CIM datetime string ("20260906123456.789012+000") to epoch
 *  ms. Returns null on anything unparsable rather than throwing — a census
 *  is best-effort and must never crash the caller. */
function parseCimDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, micro, offsetMin] = m;
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Math.floor(Number(micro) / 1000));
  return utcMs - Number(offsetMin) * 60000;
}

/** One Win32_Process query — the entire OS-touching cost of a pre-push
 *  census (~300ms). Deliberately does NOT spawn a pool: exactly one
 *  `powershell` child. Returns [] (never throws) on a non-Windows host or
 *  any PowerShell failure — a census that can't run must never block a push. */
export function collectProcessSnapshot() {
  if (!isWindows) return [];
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | " +
        "Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate," +
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
  return rows
    .map((row) => {
      const startedAt = parseCimDate(row.CreationDate);
      if (startedAt === null || row.ProcessId == null || row.ParentProcessId == null) return null;
      return {
        pid: row.ProcessId,
        ppid: row.ParentProcessId,
        name: row.Name ?? '',
        commandLine: row.CommandLine ?? '',
        cpuSeconds: Number(row.CpuSeconds) || 0,
        startedAt,
      };
    })
    .filter(Boolean);
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

/** Read the last logged sample per root pid from the JSONL census log.
 *  Missing/corrupt log -> {} (a fresh log has no history yet, which is
 *  exactly the "insufficient data" case classify() already handles by
 *  leaving cpuRatePerMin null). */
export function readPriorSamples(logPath = CENSUS_LOG_PATH) {
  if (!existsSync(logPath)) return {};
  let lines;
  try {
    lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return {};
  }
  const priorSamples = {};
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const root of entry.roots ?? []) {
      priorSamples[root.rootPid] = {
        cpuSeconds: root.cpuSecondsNow,
        sampledAt: entry.ts,
        startedAt: root.startedAt,
      };
    }
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

// ---------------------------------------------------------------------------
// Orchestration — the pre-push census and `npm run doctor`.
// ---------------------------------------------------------------------------

/**
 * Runs one census, appends it to the log, and (when `kill` is true) reaps
 * qualifying subtrees. `killReasons` narrows WHICH reap reasons this caller
 * is allowed to act on — the pre-push wiring passes only
 * ['orphaned-unreachable'] ("kill only provably-orphaned trees"); the wider
 * `--kill` manual path passes both.
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
  const priorSamples = readPrior(logPath);
  const protectedPids = ownAncestryPids(processes);

  const verdicts = classify({ processes, priorSamples, protectedPids }, now, thresholds);

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
  if (kill) {
    for (const v of verdicts) {
      if (v.verdict !== 'reap') continue;
      if (!v.reasons.some((r) => killReasons.includes(r))) continue;
      if (killFn(v.rootPid)) killed.push(v.rootPid);
    }
  }

  return { verdicts, killed };
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
    const { verdicts, killed } = runCensusFn({
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
        process.stdout.write(
          `${v.verdict.padEnd(9)} pid=${v.rootPid} rate=${v.cpuRatePerMin === null ? 'n/a' : v.cpuRatePerMin.toFixed(2)} reasons=${v.reasons.join(',') || '-'}${killedTag} :: ${v.commandLine}\n`,
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
