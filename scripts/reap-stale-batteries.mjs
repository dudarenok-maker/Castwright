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
// hook budget is ONE Win32_Process query, no pool) — they are THIS
// census and the immediately-preceding one, read back from the append-only
// log. That is also why the log records each root's command line: it is the
// dataset, not a debugging aid (see the design doc's "Deferred work" section).

import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
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
// What counts as a "battery": an allowlist of recognised runner INVOCATIONS
// ---------------------------------------------------------------------------
//
// A subtree is only EVER a reap candidate if some member is RUNNING a
// recognised test runner. The first version of this gate was a substring test
// (a word-boundary match for vitest/pytest/invoke-pester) applied to the whole
// command line, which is not an allowlist at all: it matched any process whose
// argv merely CONTAINED the word. Verified live (PR #3063 review pass 2, C2) —
// an idle "tail -f logs/vitest.log" and the reviewer's own grep probe shell
// (whose search PATTERN was the runner names) both classified
// orphaned-unreachable, and as lone roots nothing refused the taskkill /T /F.
// Orphaned tail.exe/head.exe/bash.exe are routine on this box, so that was a
// live, unattended kill of unrelated processes on every push.
//
// So this gate keys on the thing being RUN — the resolved executable, and the
// argv POSITION a runner entry point occupies — never on a word appearing
// somewhere in the string. isBatteryInvocation() below is the whole rule.
//
// DECLARED GAPS (enumerated on purpose; an honest gap beats an implied one —
// PR #3063 review pass 2, C1; PR #3063 review pass 4, P1; PR #3063 review
// pass 5, Q1):
//   * Invoke-Pester runs IN-PROCESS (scripts/tests/run.ps1:32) and never
//     appears on any command line, so a Pester run is recognisable ONLY via
//     this repo's own launcher path (scripts/tests/run.ps1, spawned by
//     run-powershell.mjs:52). A Pester run started any other way is invisible
//     to this tool and will never be reaped. Pinned by a named test.
//   * pytest IS recognised as an invocation, but can never ENABLE a kill:
//     every pytest subtree contains python.exe, and classify()'s
//     protected:python arm is evaluated first. Also pinned by a named test.
//   * The REAL gap, found by mining this tool's own census log (review pass
//     5, Q1): npm's Windows `.bin` shim does not expand to a clean
//     `node_modules/vitest/vitest.mjs` path. A live `npm test` was captured
//     verbatim as `node_modules\.bin\\..\vitest\vitest.mjs` — a doubled
//     backslash and a `..` segment neither pattern below could see, so this
//     was a 0-for-5,620 miss rate across 16 real censuses, one platform, one
//     entry point. isRunnerScriptPath() now runs the token through
//     `path.posix.normalize()` (after the existing backslash-to-slash and
//     lowercase pass) before testing it against the patterns below, which
//     collapses `.bin/../vitest` down to `vitest` and closes this for every
//     pattern here, not just vitest's. Pinned by test Q1.

const SHELL_NAMES = new Set(['cmd', 'sh', 'bash', 'powershell', 'pwsh']);
const POWERSHELL_NAMES = new Set(['powershell', 'pwsh']);
// Flags after which the NEXT argument is a command string to run, not a flag.
const SHELL_INLINE_COMMAND_FLAGS = new Set(['-c', '/c', '/k', '-command', '-encodedcommand']);
// npx flags that consume the NEXT argv token as their value (space-separated
// form) rather than taking it inline via `=`. That next token is a flag
// value, never the package/binary to run.
const NPX_VALUE_FLAGS = new Set(['-p', '--package', '--registry', '-c', '--call', '--cache']);

/** powershell.exe/pwsh accept any unambiguous prefix of `-Command` as that
 *  same switch (`-Comm`, `-Comma`, ...). Anchored at 5 chars ("-comm") so it
 *  can never collide with another `-Co...` switch (e.g. `-ConfigurationName`
 *  diverges at the 4th letter) while still covering the abbreviations
 *  actually seen in the wild. */
function isPowerShellCommandFlagPrefix(token) {
  const t = String(token ?? '').toLowerCase();
  return t.length >= 5 && '-command'.startsWith(t);
}
// Extensions a runner shim can wear without ceasing to be that runner.
const SHIM_EXTENSION_RE = /\.(cmd|bat|ps1|mjs|cjs|js)$/;
// Runner entry points identified by their PATH, anchored on the package or
// repo directory they must live in — never on a bare, generic filename.
// Crucially: these anchor on actual FILES (ending in .js/.mjs/.cjs/etc), not
// directory mentions, so a bare mention like "node_modules/vitest/" does not
// match and a quoted path with spaces still matches the file at its end.
const RUNNER_SCRIPT_PATH_RES = [
  // vitest entry point files under its package directory.
  /(^|\/)node_modules\/vitest\/[^\s\u0022\u0027]*\.(m?js|cjs)$/i,
  /(^|\/)node_modules\/\.bin\/vitest(\.cmd|\.ps1)?$/i,
  // Playwright's CLI (npm run test:e2e). "cli.js" alone is far too generic,
  // so this is anchored on the package directory it must live in, and on the
  // actual cli.js file it ends with.
  /(^|\/)node_modules\/(@playwright\/test|playwright|playwright-core)\/[^\s\u0022\u0027]*cli\.js$/i,
  // Playwright's real per-test WORKER entry point — verified live (review
  // pass 5, Q1) by capturing a real `npm run test:e2e` process tree: the
  // cli.js root forks one `node .../playwright/lib/worker/workerProcessEntry.js`
  // per worker, with no further shell/cli.js wrapper in between. If the
  // cli.js root dies (or is itself reaped) before its workers exit, an
  // orphaned worker subtree would carry no recognised member at all without
  // this — cli.js alone is not enough.
  /(^|\/)node_modules\/playwright\/lib\/worker\/workerprocessentry\.js$/i,
  // node:test — npm run test:hooks. run-hooks-tests.mjs forks one child per
  // file, so it IS a pool and IS orphan-generating.
  /(^|\/)scripts\/run-hooks-tests\.mjs$/i,
  // Pester — npm run test:scripts bottoms out in this launcher (see the
  // declared gap above).
  /(^|\/)scripts\/tests\/run\.ps1$/i,
];
// Runner names, matched against a RESOLVED executable or against a runner
// argument handed to npx — never against arbitrary text.
const RUNNER_BARE_NAMES = new Set(['vitest', 'pytest', 'playwright']);

const QUOTE_CHARS = new Set(['\u0022', '\u0027']);

/** Split a command line into argv-ish tokens, honouring single and double
 *  quotes as grouping (and stripping them). Deliberately simple: this is a
 *  classifier for `Win32_Process.CommandLine`, not a shell. */
export function tokenizeCommandLine(line) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of String(line ?? '')) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (QUOTE_CHARS.has(ch)) {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The lowercased basename of a path-or-name token, with a trailing `.exe`
 *  removed. A fully-qualified Git-for-Windows bash path becomes `bash`. */
function executableName(token) {
  const normalised = String(token ?? '').replace(/\\/g, '/');
  const base = normalised.slice(normalised.lastIndexOf('/') + 1).toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

function isRunnerScriptPath(token) {
  // Backslash-to-slash first, THEN posix-normalise, so a `..`/`//`-laden
  // Windows shim path collapses to the plain file path the patterns below
  // expect. Verified live (review pass 5, Q1): npm's Windows `.bin` shim
  // does not expand to `node_modules/vitest/vitest.mjs` — it was captured
  // verbatim as `node_modules\.bin\\..\vitest\vitest.mjs`, which neither
  // pattern below could ever match un-normalised (no `node_modules/vitest/`
  // substring, and it does not end at `.bin/vitest`). Without this, EVERY
  // npm-script-invoked runner on this repo's only supported platform was
  // unrecognisable — confirmed against this tool's own census log: 0 of
  // 5,620 root records recognised across 16 real censuses.
  const p = posix.normalize(
    String(token ?? '')
      .replace(/\\/g, '/')
      .toLowerCase(),
  );
  return RUNNER_SCRIPT_PATH_RES.some((re) => re.test(p));
}

function isRunnerBareName(token) {
  return RUNNER_BARE_NAMES.has(executableName(token).replace(SHIM_EXTENSION_RE, ''));
}

/**
 * True when `commandLine` is a recognised test-runner invocation — i.e. this
 * process is RUNNING a battery, not merely mentioning one. See the block
 * comment above for why that distinction is the entire point of the gate.
 *
 * A shell wrapper is not itself a battery: its inline command argument is
 * unwrapped and the SAME test applied to that. That is what keeps
 * `cmd /c npx vitest run` recognised while a shell whose -c payload merely
 * greps for the word is not — the inner executable is grep, and grep runs no
 * battery.
 */
export function isBatteryInvocation(commandLine, depth = 0) {
  if (depth > 3) return false; // bounded: a shell wrapping a shell wrapping ...
  const tokens = tokenizeCommandLine(commandLine);
  if (tokens.length === 0) return false;
  const exe = executableName(tokens[0]);
  const args = tokens.slice(1);

  if (SHELL_NAMES.has(exe)) {
    const isPowerShellExe = POWERSHELL_NAMES.has(exe);
    const flagIdx = args.findIndex(
      (a) => SHELL_INLINE_COMMAND_FLAGS.has(a.toLowerCase()) || (isPowerShellExe && isPowerShellCommandFlagPrefix(a)),
    );
    if (flagIdx >= 0 && flagIdx + 1 < args.length) {
      return isBatteryInvocation(args.slice(flagIdx + 1).join(' '), depth + 1);
    }
    // `pwsh -ExecutionPolicy Bypass -NoProfile -File .../run.ps1` — a script
    // PATH argument bound to -File specifically, never a mention anywhere
    // else in argv (npm run test:scripts).
    const fileIdx = args.findIndex((a) => a.toLowerCase() === '-file');
    if (fileIdx >= 0 && fileIdx + 1 < args.length) {
      return isRunnerScriptPath(args[fileIdx + 1]);
    }
    if (isPowerShellExe) {
      // powershell/pwsh bind a bare (non-switch) argument positionally to
      // -Command when nothing else has claimed it (`powershell "Get-Content
      // ..."`). Recurse on that ONE bound argument — never scan the rest of
      // argv for a runner path.
      const positional = args.find((a) => !a.startsWith('-'));
      if (positional !== undefined) return isBatteryInvocation(positional, depth + 1);
    }
    // No recognised shell-invocation shape: an unmatched/unknown flag, or a
    // bare POSIX shell (bash/sh/cmd) given no -c/-file/-command argument at
    // all. Falling back to `args.some(isRunnerScriptPath)` here is exactly
    // the C1/C2 hole this gate exists to close (PR #3063 review pass 3) —
    // it substring-scans an opaque, unparsed payload for a runner path
    // appearing ANYWHERE inside it, which a `vim .../run.ps1` or a
    // `tail -f .../vitest/x.log` also satisfies. "We could not parse this
    // shell's arguments" is a different statement from "this is a battery",
    // and this script force-kills process trees unattended, so the
    // unrecognised case must fail closed: not a battery.
    return false;
  }
  if (exe === 'node' || exe === 'nodejs') {
    // `node --test <files>` — node:test's own per-file fork pool (test:hooks).
    if (args.some((a) => a === '--test' || a.startsWith('--test='))) return true;
    // Check arguments for runner script paths. The RUNNER_SCRIPT_PATH_RES
    // patterns now anchor on actual FILES (ending in .js/.mjs/.cjs), not
    // directory mentions — so they safely ignore inline -e payloads,
    // log filenames, and other false positives without needing a whitespace
    // guard. A quoted path with spaces (from a shell) becomes a single
    // token with internal spaces, and the file-anchored regex still matches
    // if the basename is a recognised entry point.
    return args.some((a) => isRunnerScriptPath(a));
  }
  if (exe === 'npx' || exe === 'npx.cmd') {
    // npx's first non-flag argument is the package/binary to run. Find it
    // and check ONLY that one, never scan the rest of argv for a runner name
    // appearing anywhere (that was the C2 substring-matching hole). Flags
    // start with `-` and some take their OWN value as a separate argv
    // token (`--registry <url>`, `-p vitest@4`), not just the `--flag=value`
    // form the loop already skipped for free. Without skipping that value
    // token too, it gets mistaken for the package/binary argument and the
    // loop returns on it — `npx --registry <url> vitest run` and
    // `npx -p vitest@4 vitest run` both regressed true -> false this way
    // (review pass 5, Q3) even though the code comment already claimed
    // value-taking flags were handled.
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg.startsWith('-')) {
        if (!arg.includes('=') && NPX_VALUE_FLAGS.has(arg.toLowerCase())) i += 1; // skip its value token
        continue;
      }
      // This is the package name argument — the only one we check.
      return isRunnerBareName(arg) || isRunnerScriptPath(arg);
    }
    return false;
  }
  if (exe === 'python' || exe === 'python3' || exe === 'py') {
    // `python -m pytest ...` — the module NAME argument, in its own argv
    // position, never a mention anywhere in the line.
    const moduleIdx = args.indexOf('-m');
    return moduleIdx >= 0 && args[moduleIdx + 1] === 'pytest';
  }
  // A runner shim invoked directly: vitest.cmd, pytest.exe, playwright.cmd.
  return isRunnerBareName(exe);
}

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
    const isBatteryCandidate = members.some((m) => isBatteryInvocation(m.commandLine));

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
      // Nothing below this line can fire for a subtree that never RAN a
      // recognised runner — see isBatteryInvocation's comment. An orphaned,
      // idle `steam.exe` and a busy, live-parented `npm run dev` both fall
      // through with verdict 'alive', reasons [], regardless of how they'd
      // otherwise score. Note the arm ORDER: this gate is the LAST arm, after
      // python / self-ancestry / git-overlap, not before them. No behavioural
      // difference — every earlier arm also yields 'alive' — but the comment
      // used to claim the reverse (PR #3063 review pass 2, N2).
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
 *  census. Measured live (PR #3063 review pass 2, N1): ~694ms for this
 *  query alone, and ~0.8-3.5s for a whole runCensus on a 415-root box — NOT
 *  the "~300ms" earlier drafts of this file, the hook, and the release note
 *  all claimed. The invariant that matters is unchanged and is the one the
 *  hook guard actually enforces: NO POOL. Deliberately spawns exactly one
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

// Bound for readPriorSamples' tail read, SIZED AGAINST THE TRUST WINDOW rather
// than picked as a round number. The log is append-only and never re-read in
// full: re-parsing the whole file every push grows unboundedly and blows the
// hook's budget. But the window must still be big enough to CONTAIN a sample
// old enough to trust — a prior sample only counts once it is
// `minSampleAgeMs` old (default 10 min), so a tail that holds fewer entries
// than the fastest realistic census cadence produces in that span silently
// switches the rate detector off.
//
// Measured live (PR #3063 review pass 2, C6): 214,013 bytes per entry on a
// 415-root box. The previous flat 2 MB therefore held only NINE entries, and
// E104's own acceptance criterion (2) — "run it again ~10+ minutes later",
// with a handful of `npm run doctor` runs in between — evicted every
// sufficiently-old sample from the window, so `stalled-rate` went dark for
// every root exactly while an operator was using the tool to look for a stall.
const CENSUS_ENTRY_BYTES = 220 * 1024;
// The shortest interval between two censuses worth sizing for: a human
// running `npm run doctor` repeatedly while investigating, or a burst of
// pushes across sibling worktrees. Faster than this and the fallback (an
// untrusted rate) is the correct answer anyway.
const FASTEST_CENSUS_INTERVAL_MS = 30_000;

/** Bytes of trailing census log that must be read to still contain a sample
 *  at least `minSampleAgeMs` old at the fastest cadence worth sizing for.
 *  Exported so the sizing rule itself is testable, not just its output. */
export function tailBytesFor(minSampleAgeMs) {
  // +1 entry for the boundary: the Nth-oldest entry in the window must be
  // strictly older than the threshold, not exactly at it.
  const entries = Math.ceil(minSampleAgeMs / FASTEST_CENSUS_INTERVAL_MS) + 1;
  return entries * CENSUS_ENTRY_BYTES;
}

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
  { now = Date.now(), minSampleAgeMs = DEFAULT_THRESHOLDS.minSampleAgeMs, tailBytes } = {},
) {
  if (!existsSync(logPath)) return {};
  // Derived from the CALLER's window, not from a module-level default, so a
  // caller that widens minSampleAgeMs automatically widens the tail with it.
  const windowBytes = tailBytes ?? tailBytesFor(minSampleAgeMs);
  let text;
  try {
    text = readTailText(logPath, windowBytes);
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

// Retention (PR #3063 review pass 2, N3): at ~214 KB per entry this log gains
// ~214 KB per push PER WORKTREE, and with 18 live trees that is ~3.9 MB per
// round. It is deliberately kept — it IS the dataset the design's deferred
// concurrency-governor question needs — but "kept" is not the same as
// "unbounded". At this cap each generation holds roughly 300 entries and total
// on-disk cost is bounded at 2x the cap, since exactly ONE previous generation
// is retained (`<log>.1`, replaced on each roll). Rolling loses the prior
// samples for exactly one census, whose only effect is an untrusted rate for
// that run — the same fail-closed path a fresh log already takes.
export const MAX_CENSUS_LOG_BYTES = 64 * 1024 * 1024;

/** Append one census entry — every root's command line, per the ticket
 *  ("the 2026-09-05 census omitted it"), plus what was actually DONE to it
 *  (see runCensus). Rolls the log once it passes `maxBytes` (see above).
 *
 *  Guards a missing trailing newline before appending: a census killed
 *  mid-`appendFileSync` leaves a fragment, and without this the NEXT append
 *  concatenates onto it and that entry is lost too (N5). The fragment itself
 *  still fails to parse and is skipped, which is expected and tolerated. */
export function appendCensusLog(entry, logPath = CENSUS_LOG_PATH, { maxBytes = MAX_CENSUS_LOG_BYTES } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  let needsLeadingNewline = false;
  if (existsSync(logPath)) {
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      size = 0;
    }
    if (size >= maxBytes) {
      try {
        renameSync(logPath, `${logPath}.1`);
        size = 0;
      } catch {
        // A locked/undeletable previous generation must never block a push:
        // keep appending to the current log rather than throwing.
      }
    }
    if (size > 0) {
      const fd = openSync(logPath, 'r');
      try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        needsLeadingNewline = last[0] !== 0x0a;
      } finally {
        closeSync(fd);
      }
    }
  }
  appendFileSync(logPath, `${needsLeadingNewline ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf8');
}

// The kill's own spawn budget. `collectProcessSnapshot` has always bounded its
// child; `killTree` did not, which made the killer the ONE unbounded spawn on
// the hook path (PR #3063 review pass 2, C5). runCli's try/catch converts a
// THROW into exit 0 but cannot observe a HANG, so a `taskkill` that blocks —
// an uninterruptible or debugger-attached target — would hang `git push`
// indefinitely, defeating the headline "never blocks a push" on the exact path
// the suite could not reach. A timed-out spawn sets `result.error`, so it
// reports false and the root is never recorded as killed.
export const KILL_TIMEOUT_MS = 15000;

/** Kill one subtree by its root pid. Windows-only (matches this repo's
 *  primary platform and the prior art in scripts/stop-app.mjs); a no-op
 *  elsewhere rather than a throw.
 *
 *  `spawn`/`windows` are injectable purely so the spawn BUDGET and the
 *  timed-out-spawn path are testable on any platform — nothing in production
 *  passes them.
 *
 *  Residual, accepted and named rather than fixed (PR #3063 review pass 2,
 *  N4): this call re-validates nothing about `pid` itself. The census
 *  enumeration completes 0.7-3.5 s before the first taskkill, so if the root
 *  exits inside that window and Windows recycles its pid, `/T` lands on an
 *  unrelated new tree. classify() guards PID reuse for CLASSIFICATION (the
 *  startedAt checks in resolveRoot and the prior-sample match); the kill site
 *  has no equivalent, and closing it would need a second
 *  `Get-CimInstance -Filter ProcessId=<pid>` creation-time re-check per kill. */
export function killTree(pid, { spawn = spawnSync, windows = isWindows } = {}) {
  if (!windows) return false;
  const result = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: KILL_TIMEOUT_MS,
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
 * (`{rootPid, reason}`), never in `killed`. A kill that was ATTEMPTED but
 * whose `taskkill` failed or timed out (`killFn` returns falsy) lands in
 * `failed`, never silently in neither bucket — a failed kill must stay
 * distinguishable from one never attempted at all.
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

  const killed = [];
  const refused = [];
  const failed = [];
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
      if (killFn(v.rootPid)) {
        killed.push(v.rootPid);
      } else {
        failed.push(v.rootPid);
      }
    }
  }

  // The log is written AFTER the kill loop, deliberately: it used to be
  // appended before it, so by construction it could never carry what was
  // actually DONE — a pre-push reap produced empty stdout, empty stderr, exit
  // 0, and a log line recording only a VERDICT (PR #3063 review pass 2, C4).
  // A tool that silently kills processes on every push is not acceptable; the
  // record is half of making that observable, and runCli's pre-push stderr
  // line is the other half.
  const refusalByRoot = new Map(refused.map((r) => [r.rootPid, r.reason]));
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
        killed: killed.includes(v.rootPid),
        refusalReason: refusalByRoot.get(v.rootPid) ?? null,
        killFailed: failed.includes(v.rootPid),
      })),
    },
    logPath,
  );

  return { verdicts, killed, refused, failed };
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
    const { verdicts, killed, refused, failed } = runCensusFn({
      kill: isPrePush || wideKill,
      // Pre-push is the narrow, never-blocking path: only kill what is
      // PROVABLY orphaned (dead parent), never a merely-slow subtree that
      // might still land. `--kill` (npm run doctor -- --kill) is the wider,
      // human-invoked path and may also reap stalled-but-live-parented work.
      killReasons: isPrePush && !wideKill ? ['orphaned-unreachable'] : ['orphaned-unreachable', 'stalled-rate'],
    });

    if (isPrePush) {
      // A pre-push kill must never be silent (C4). The full per-root report
      // stays off this path (it is hundreds of lines), but anything ACTED on
      // is named, on stderr so it cannot be confused with tool output and
      // cannot affect the push's own exit status. Nothing is printed on the
      // common case where nothing was killed or refused.
      for (const pid of killed) {
        const v = verdicts.find((x) => x.rootPid === pid);
        process.stderr.write(
          `reap-stale-batteries: KILLED stale battery pid=${pid} reasons=${v?.reasons?.join(',') || '-'} :: ${v?.commandLine ?? ''}\n`,
        );
      }
      for (const entry of refused ?? []) {
        process.stderr.write(`reap-stale-batteries: REFUSED pid=${entry.rootPid} :: ${entry.reason}\n`);
      }
      for (const pid of failed ?? []) {
        const v = verdicts.find((x) => x.rootPid === pid);
        process.stderr.write(
          `reap-stale-batteries: KILL FAILED pid=${pid} reasons=${v?.reasons?.join(',') || '-'} :: ${v?.commandLine ?? ''}\n`,
        );
      }
    } else {
      for (const v of verdicts) {
        const killedTag = killed.includes(v.rootPid) ? ' [KILLED]' : '';
        const refusedEntry = (refused ?? []).find((r) => r.rootPid === v.rootPid);
        const refusedTag = refusedEntry ? ` [REFUSED: ${refusedEntry.reason}]` : '';
        const failedTag = (failed ?? []).includes(v.rootPid) ? ' [KILL FAILED]' : '';
        process.stdout.write(
          `${v.verdict.padEnd(9)} pid=${v.rootPid} rate=${v.cpuRatePerMin === null ? 'n/a' : v.cpuRatePerMin.toFixed(2)} reasons=${v.reasons.join(',') || '-'}${killedTag}${refusedTag}${failedTag} :: ${v.commandLine}\n`,
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
