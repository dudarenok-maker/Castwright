#!/usr/bin/env node
// Worktree garbage collector — ops-75 commit-gate rebalance Part 4 (#3051).
// Design of record: docs/superpowers/specs/2026-09-05-commit-gate-rebalance-design.md
// Part 4. See CLAUDE.md "Worktree teardown" for the manual recipe this
// automates and the hazards it exists to close (12 of 14 orphaned worktree
// junctions found pointing at the primary checkout's real
// node_modules/.venv/Kokoro weights on 2026-09-06 — 8.27 GB across 28
// directories).
//
// Usage:
//   node scripts/wt-gc.mjs            # report only (the default — no mutation)
//   node scripts/wt-gc.mjs --prune    # actually remove prunable worktrees
//
// Report columns per non-primary worktree: path, branch, merged-into-main,
// commits-ahead-of-main, dirty, unpushed, PR state (when `gh` is available
// and authenticated — degrades to "unknown" otherwise, never an error).
//
// Refuses to prune three shapes, always, regardless of --prune:
//   1. the primary checkout — never touched;
//   2. a tree with uncommitted changes (`git status --porcelain` non-empty);
//   3. a tree with unpushed commits — including a branch with NO upstream at
//      all, which is treated as "can't verify it's pushed" and refused, not
//      silently assumed safe.
//
// Teardown order for a worktree that clears all three refusals — load-bearing,
// not incidental (CLAUDE.md "Worktree teardown", #3051's own regression
// history):
//   1. Recursively find every reparse-point (junction) directory under the
//      worktree root via scripts/lib/wt-gc-junctions.psm1's
//      Get-JunctionsRecursive, gated on the ReparsePoint ATTRIBUTE BIT —
//      never `.LinkTarget`, which reads empty on this box's Windows
//      PowerShell 5.1 even for a real junction (see that module's header).
//   2. Unlink each one via [System.IO.Directory]::Delete($p, $false) — the
//      `$false` refuses to recurse, so this can only ever remove the link,
//      never the target it points at.
//   3. Verify removal with Test-Path on both the (now-gone) link and its
//      (still-present) target — never by trusting a non-throwing call, since
//      `cmd /c rmdir` from a bash shell is on record silently no-op'ing and
//      returning 0.
//   4. Only THEN `git worktree remove --force <path>` — safe now that no
//      junction inside the tree can be followed into the primary checkout.
//
// Offline tolerance: every `gh` call goes through scripts/gh.mjs's
// ghSpawn() (the repo's mandatory chokepoint, #2184) and degrades to
// "unknown" PR state on any failure — `gh` missing, unauthenticated, or a
// network error never aborts the report or the prune.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from './git-env.mjs';
import { ghSpawn } from './gh.mjs';
import { parseWorktreePorcelain } from './wt-list.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');
const junctionScriptPath = join(__dirname, 'lib', 'wt-gc-junctions.ps1');

// ---- Argument parsing -------------------------------------------------------

export function parseArgs(argv) {
  const args = { prune: false, help: false };
  for (const a of argv) {
    if (a === '--prune') args.prune = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function usage(extra) {
  const lines = [
    'Usage: node scripts/wt-gc.mjs [--prune]',
    '',
    'Report mode (default): lists worktrees with commits-ahead-of-main,',
    'merged status, and PR state (when `gh` is available). No mutation.',
    '',
    '--prune: actually remove worktrees that clear all three refusals',
    '(primary checkout, uncommitted changes, unpushed commits) — junctions',
    'first, then the worktree itself. See CLAUDE.md "Worktree teardown".',
  ];
  if (extra) lines.unshift(`Error: ${extra}`, '');
  return lines.join('\n');
}

// ---- Default runners (real git / real gh / real PowerShell) ---------------

export function makeDefaultRunners() {
  return {
    git(args, opts = {}) {
      const result = spawnSync('git', args, {
        encoding: 'utf8',
        windowsHide: true,
        cwd: repoRoot,
        ...opts,
        env: scrubGitEnv(opts.env),
      });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
      };
    },
    // Availability + lookup collapsed into one call: a caller that can't
    // reach `gh` (missing binary, no auth, no network) gets `null` back,
    // never a thrown error — offline tolerance is the contract, not an
    // opt-in.
    ghPrState(branch) {
      const result = ghSpawn(
        ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url', '--limit', '1'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (result.error || result.status !== 0) return null;
      try {
        const rows = JSON.parse(result.stdout || '[]');
        return rows[0] ?? null;
      } catch {
        return null;
      }
    },
    // Junction-first teardown primitive — see this file's header. Returns
    // { items } parsed from the PowerShell helper's JSON, or throws with a
    // clear message if PowerShell itself can't be found (never silently
    // "succeeds" having removed nothing).
    removeJunctions(root) {
      return runJunctionScript(root, 'Remove').items;
    },
    removeWorktree(path) {
      const result = spawnSync('git', ['worktree', 'remove', '--force', path], {
        encoding: 'utf8',
        windowsHide: true,
        cwd: repoRoot,
        env: scrubGitEnv(),
      });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
      };
    },
    pathExists(path) {
      return existsSync(path);
    },
    log(text) {
      process.stdout.write(text);
    },
    err(text) {
      process.stderr.write(text);
    },
  };
}

function pickPowerShell() {
  for (const bin of ['pwsh', 'powershell']) {
    const probe = spawnSync(bin, ['-NoProfile', '-Command', '$null'], { stdio: 'ignore', windowsHide: true });
    if (probe.error == null) return bin;
  }
  return null;
}

function runJunctionScript(root, action) {
  const shell = pickPowerShell();
  if (!shell) {
    throw new Error(
      'wt-gc: neither `pwsh` nor `powershell` found on PATH — cannot inspect/remove junctions safely.',
    );
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', junctionScriptPath, '-Root', root, '-Action', action];
  const result = spawnSync(shell, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) {
    throw new Error(`wt-gc: failed to spawn ${shell} for junction ${action}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`wt-gc: junction ${action} script exited ${result.status}:\n${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`wt-gc: junction ${action} script produced unparseable JSON: ${e.message}\n${result.stdout}`);
  }
}

// ---- Pure classification logic (no git/gh/PowerShell calls) ---------------

/**
 * Is `path` the main worktree — i.e. its own git-dir IS the common git-dir,
 * which is true only for the primary checkout (a linked worktree's git-dir
 * always lives under the common dir's `worktrees/<name>`, never equal to it).
 * More robust than "first entry in `git worktree list`" (documented git
 * behaviour, but not something this script's safety property should lean on
 * alone) — this is a direct structural check.
 */
export function isPrimaryWorktree(gitCommonDir, gitDir) {
  return gitCommonDir === gitDir;
}

/**
 * The three mandatory refusal reasons, and nothing else — see this file's
 * header. `unpushed: true` covers BOTH "has commits ahead of its upstream"
 * AND "has no upstream configured at all" (hasUpstream: false) — an
 * unverifiable push state is refused, not assumed safe. Returns an array;
 * empty means the worktree clears every refusal and is eligible for
 * --prune.
 */
export function refusalReasons(facts) {
  const reasons = [];
  if (facts.isPrimary) reasons.push('primary checkout — never pruned');
  if (facts.dirty) reasons.push('uncommitted changes');
  if (!facts.hasUpstream) reasons.push('no upstream configured — cannot verify it is pushed');
  else if (facts.unpushedCount > 0) reasons.push(`${facts.unpushedCount} unpushed commit(s)`);
  return reasons;
}

/** Assemble one report row from raw facts + optional PR info. Pure. */
export function classifyWorktree(tree, facts, prInfo) {
  return {
    path: tree.path,
    branch: tree.branch ?? '(detached)',
    mergedIntoMain: facts.mergedIntoMain,
    aheadOfMain: facts.aheadCount,
    dirty: facts.dirty,
    hasUpstream: facts.hasUpstream,
    unpushedCount: facts.unpushedCount,
    prState: prInfo ? `#${prInfo.number} ${prInfo.state}` : 'unknown',
    refusals: refusalReasons(facts),
  };
}

// ---- Fact-gathering (git calls, isolated so the classification above stays pure) --

function gatherFacts(git, tree, isPrimary) {
  const head = tree.head;
  const branch = tree.branch;

  const dirtyResult = git(['status', '--porcelain'], { cwd: tree.path });
  const dirty = dirtyResult.status === 0 ? dirtyResult.stdout.trim().length > 0 : true; // fail closed

  const mergedResult = git(['merge-base', '--is-ancestor', head, 'main'], { cwd: tree.path });
  const mergedIntoMain = mergedResult.status === 0;

  const aheadResult = git(['rev-list', '--count', `main..${head}`], { cwd: tree.path });
  const aheadCount = aheadResult.status === 0 ? parseInt(aheadResult.stdout.trim(), 10) || 0 : null;

  let hasUpstream = false;
  let unpushedCount = 0;
  if (branch && branch !== '(detached)') {
    const upstreamResult = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], {
      cwd: tree.path,
    });
    hasUpstream = upstreamResult.status === 0;
    if (hasUpstream) {
      const upstream = upstreamResult.stdout.trim();
      const unpushedResult = git(['rev-list', '--count', `${upstream}..${branch}`], { cwd: tree.path });
      unpushedCount = unpushedResult.status === 0 ? parseInt(unpushedResult.stdout.trim(), 10) || 0 : null;
      if (unpushedCount === null) hasUpstream = false; // couldn't verify — fail closed via refusalReasons
    }
  }

  return { isPrimary, dirty, mergedIntoMain, aheadCount, hasUpstream, unpushedCount };
}

// ---- Report + prune formatting ---------------------------------------------

function formatReportTable(rows) {
  const header = ['path', 'branch', 'merged', 'ahead', 'dirty', 'PR', 'prunable?'];
  const body = rows.map((r) => [
    r.path,
    r.branch,
    String(r.mergedIntoMain),
    String(r.aheadOfMain ?? '?'),
    String(r.dirty),
    r.prState,
    r.refusals.length === 0 ? 'yes' : `no (${r.refusals.join('; ')})`,
  ]);
  const all = [header, ...body];
  const widths = header.map((_, col) => all.reduce((max, row) => Math.max(max, String(row[col]).length), 0));
  const fmt = (row) => row.map((cell, col) => String(cell).padEnd(widths[col])).join('  ');
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(fmt)].join('\n');
}

// ---- Main run ----------------------------------------------------------------

/**
 * @param {Object} opts
 * @param {boolean} opts.prune
 * @param {Object} opts.runners
 * @returns {number} exit code
 */
export function run({ prune, runners }) {
  const { git, ghPrState, removeJunctions, removeWorktree, pathExists, log, err } = runners;

  const porcelainResult = git(['worktree', 'list', '--porcelain']);
  if (porcelainResult.status !== 0) {
    err(`git worktree list failed:\n${porcelainResult.stderr || porcelainResult.stdout}\n`);
    return 1;
  }
  const trees = parseWorktreePorcelain(porcelainResult.stdout);
  if (trees.length === 0) {
    log('No worktrees found.\n');
    return 0;
  }

  const commonDirResult = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = commonDirResult.status === 0 ? commonDirResult.stdout.trim() : null;

  const rows = [];
  for (const tree of trees) {
    const gitDirResult = git(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: tree.path });
    const gitDir = gitDirResult.status === 0 ? gitDirResult.stdout.trim() : null;
    const isPrimary = commonDir !== null && gitDir !== null && isPrimaryWorktree(commonDir, gitDir);

    const facts = gatherFacts(git, tree, isPrimary);
    const prInfo = tree.branch && tree.branch !== '(detached)' ? ghPrState(tree.branch) : null;
    rows.push(classifyWorktree(tree, facts, prInfo));
  }

  log(formatReportTable(rows) + '\n');

  if (!prune) {
    log('\nReport mode (default). Re-run with --prune to remove the worktrees marked "prunable? yes".\n');
    return 0;
  }

  log('\n--- Pruning ---\n');
  let failures = 0;
  for (const row of rows) {
    if (row.refusals.length > 0) {
      log(`SKIP ${row.path} — ${row.refusals.join('; ')}\n`);
      continue;
    }

    log(`Pruning ${row.path}...\n`);

    // Step 1-3: junctions first, verified.
    let junctionReport;
    try {
      junctionReport = removeJunctions(row.path);
    } catch (e) {
      err(`  junction removal failed: ${e.message}\n`);
      failures += 1;
      continue;
    }
    let junctionFailure = false;
    for (const j of junctionReport) {
      if (!j.Removed || j.TargetStillExists === false) {
        err(`  junction NOT cleanly removed: ${JSON.stringify(j)}\n`);
        junctionFailure = true;
      }
    }
    if (junctionFailure) {
      failures += 1;
      continue;
    }
    log(`  removed ${junctionReport.length} junction(s)\n`);

    // Step 4: only now is it safe to recursively remove the worktree.
    const removeResult = removeWorktree(row.path);
    if (removeResult.status !== 0) {
      err(`  git worktree remove failed:\n${removeResult.stderr || removeResult.stdout}\n`);
      failures += 1;
      continue;
    }

    // Verify with Test-Path (fs.existsSync), never with the exit code alone.
    if (pathExists(row.path)) {
      err(`  ${row.path} still exists after removal (git reported success) — flagging, not trusting the exit code\n`);
      failures += 1;
      continue;
    }
    log(`  removed.\n`);
  }

  return failures > 0 ? 1 : 0;
}

// ---- CLI entry --------------------------------------------------------------

export function main(argv = process.argv.slice(2), runners = makeDefaultRunners()) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    runners.err(usage(e.message) + '\n');
    return 1;
  }
  if (args.help) {
    runners.log(usage() + '\n');
    return 0;
  }
  return run({ prune: args.prune, runners });
}

// process.exit() truncates pending async stdout writes on POSIX pipes
// (synchronous on Windows, ASYNCHRONOUS on Linux/macOS) — see the comment by
// scripts/lib/is-main-module.mjs's own isDirectlyInvoked for why the
// process.exit(main()) shape is unsafe for anything but provably-tiny
// output. run()'s report table can run to one row per worktree plus a
// per-item prune log, so it doesn't qualify; setting exitCode and letting
// the process exit naturally once the event loop drains (main() is fully
// synchronous — every git/gh/PowerShell call is spawnSync) avoids the
// truncation instead.
if (isDirectlyInvoked(import.meta.url)) {
  process.exitCode = main();
}
