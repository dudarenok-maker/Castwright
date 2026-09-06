#!/usr/bin/env node
// Worktree garbage collector — ops-75 commit-gate rebalance Part 4 (#3051).
// Design of record: docs/superpowers/specs/2026-09-05-commit-gate-rebalance-design.md
// Part 4. See CLAUDE.md "Worktree teardown" for the manual recipe this
// automates and the hazard it exists to close: on 2026-09-06, 12 of 14
// worktree junctions were found pointing at the primary checkout's real
// node_modules/.venv/Kokoro weights, so a `Remove-Item -Recurse` teardown
// would have followed one into the primary checkout and deleted the target.
//
// SCOPE — read this before sizing the tool against that sweep. This operates
// on the worktrees `git worktree list` REGISTERS, and only those. The 28
// directories / 8.27 GB the 2026-09-06 sweep counted were ORPHANED
// directories — ones git no longer knows about — and those are structurally
// invisible here: they appear in no porcelain, so `wt:gc` neither lists nor
// reclaims them. What this tool does is stop registered worktrees from
// BECOMING that: it makes the junction-first teardown recipe routine and
// refuses to run it on a tree that is not safe to lose. Reclaiming an
// already-orphaned directory remains the manual recipe in CLAUDE.md
// "Worktree teardown", and #3051's acceptance list does not ask for it.
//
// Usage:
//   node scripts/wt-gc.mjs            # report only (the default — no mutation)
//   node scripts/wt-gc.mjs --prune    # actually remove prunable worktrees
//
// Report columns per non-primary worktree: path, branch, merged-into-main,
// commits-ahead-of-main, dirty, PR state (when `gh` is available and
// authenticated), and the prunable?/refusal cell. Unpushed state is not its
// own column — it surfaces inside the refusal text (`N unpushed commit(s)` /
// `no upstream configured`), which is where a reader needs it. REPORT MODE
// QUERIES `gh` FOR EVERY BRANCHED ROW, including ones already refused on
// other grounds: in report mode the table IS the product, and a PR column
// reading `not queried` for 16 of 18 rows is worth less than the round-trips
// it saves. `--prune` skips the query for an already-refused row, where the
// answer genuinely cannot change the outcome.
//
// Refuses to prune seven shapes, always, regardless of --prune. Every one of
// them fails CLOSED: an unanswerable question is a refusal, never a pass.
//   1. the primary checkout — never touched. If git cannot answer
//      `rev-parse --git-common-dir`/`--git-dir`, the tree is TREATED AS the
//      primary checkout rather than assumed to be a linked worktree;
//   2. the worktree this process is itself running from. `git worktree
//      remove --force` run from inside its own tree deletes every file and
//      deregisters the worktree, then fails the final rmdir with exit 255 —
//      leaving exactly the orphaned, no-longer-registered directory this
//      tool exists to remove, and reporting it as a failed prune;
//   3. a tree with uncommitted changes (`git status --porcelain` non-empty);
//   4. a tree whose branch is NOT merged into `main`. Teardown destroys
//      per-worktree state that does not travel with the branch — `server/.env`
//      (`PORT`/`WORKSPACE_DIR`/`LOCAL_TTS_PORT`), `.env.local`, the
//      `node_modules` junctions, `server/tts-sidecar/.venv` and `voices/`
//      (CLAUDE.md "Branching workflow" → "Git-ignored artifacts ... are
//      destroyed by worktree teardown"). "The commits are pushed so nothing
//      is lost" is false: the commits survive, the environment does not.
//      This is #3051's own acceptance #1, which names merged as a refusal
//      case; the design doc's Part 4 sentence listed only three and is
//      amended by this file (see the PR body for the reconciliation);
//   5. a tree whose branch has unpushed commits — including a branch with NO
//      upstream at all, which is treated as "can't verify it's pushed" and
//      refused, not silently assumed safe;
//   6. a tree whose branch carries an OPEN PR — an in-flight lane — or whose
//      PR state could not be determined at all (`gh` missing, unauthenticated
//      or offline). "gh answered: no PR exists" and "gh could not be asked"
//      are DIFFERENT answers here and are reported and treated differently:
//      the first is safe, the second is a refusal;
//   7. a tree `git worktree lock` marked as locked — git's own, explicit "do
//      not remove this" signal, which the porcelain already carries
//      (scripts/wt-list.mjs parses it). Without this refusal a locked tree
//      cleared every other check, had its junctions unlinked, and only THEN
//      hit `fatal: cannot remove a locked working tree` — leaving the tree
//      registered but stripped of node_modules/.venv/voices, i.e. git's
//      backstop protected the directory and not the environment inside it.
//      Same shape as refusals 1 and 2: the destructive step must run AFTER
//      the thing that honours the refusal, not before it.
//
// `mergedIntoMain` is computed against the LOCAL `main`
// (`git merge-base --is-ancestor <head> main`), so a stale local `main`
// reports a genuinely-merged tree as unmerged. That errs toward refusing,
// which is the safe direction; `git fetch && git merge --ff-only main` first
// if a row you expect to be prunable reads `merged false`.
//
// Teardown order for a worktree that clears every refusal — load-bearing,
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
//   4. RE-SCAN the tree and fail if anything reparse-shaped is still (or
//      newly) there. Steps 1-3 enumerate once and then delete, so a junction
//      created in the window between them — an `npm install` or a
//      `wt-new.mjs` finishing inside that tree — would be live and unseen
//      when step 5 runs. The re-scan reports it as an un-removed junction
//      rather than removing it: something is actively writing in a tree this
//      tool is about to destroy, and that is a reason to stop, not to sweep
//      harder. Implemented inside Remove-JunctionsRecursive so the check
//      cannot be skipped by a caller.
//   5. Only THEN `git worktree remove --force <path>` — safe now that no
//      junction inside the tree can be followed into the primary checkout.
//
// Offline tolerance: every `gh` call goes through scripts/gh.mjs's
// ghSpawn() (the repo's mandatory chokepoint, #2184) and degrades to
// "unknown (gh unavailable)" PR state on any failure — `gh` missing,
// unauthenticated, or a network error never aborts the REPORT. It does
// refuse the PRUNE for that row (refusal 6 above): offline tolerance means
// the tool keeps working, not that it deletes trees it could not check.

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
    'Report mode (default): lists the REGISTERED worktrees (`git worktree',
    'list`) with commits-ahead-of-main, merged status, and PR state (queried',
    'for every branched row when `gh` is available). No mutation. An orphaned',
    'directory git no longer knows about is NOT listed — see the file header.',
    '',
    '--prune: actually remove worktrees that clear every refusal (primary',
    "checkout, this process's own worktree, uncommitted changes, not merged",
    'into main, unpushed commits, an open or undeterminable PR, a `git',
    'worktree lock`) — junctions first, then the worktree itself. Skips the',
    '`gh` query for rows already refused on other grounds. See CLAUDE.md',
    '"Worktree teardown".',
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
    // Availability + lookup, kept DISTINGUISHABLE. `gh pr list --head <b>`
    // prints `[]` and exits 0 when there is genuinely no PR, which is
    // character-for-character what an uninstalled/unauthenticated/offline
    // `gh` used to render as here — the same `unknown` token for "definitely
    // no PR" and "couldn't ask". They are opposite answers for a destructive
    // default, so this returns a two-field verdict instead of one nullable
    // row: `{ available, pr }`. `available:false` means gh could not be
    // asked (never a thrown error — offline tolerance is the contract);
    // `available:true, pr:null` means gh answered and there is no PR.
    ghPrState(branch) {
      const result = ghSpawn(
        ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url', '--limit', '1'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (result.error || result.status !== 0) return { available: false, pr: null };
      try {
        const rows = JSON.parse(result.stdout || '[]');
        return { available: true, pr: rows[0] ?? null };
      } catch {
        // Unparseable output means gh answered something this code does not
        // understand — that is "couldn't ask", not "no PR".
        return { available: false, pr: null };
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
 * Is `worktreePath` the tree this very process is running from (or an
 * ancestor of it)? Comparing both the script's own repo root AND the
 * process cwd catches the two ways it happens: `npm run wt:gc` from inside
 * a worktree (that worktree's own copy of the script), and
 * `node <primary>/scripts/wt-gc.mjs` invoked while cwd sits in a worktree.
 * Normalisation is separator- and case-insensitive because this is a
 * Windows-only tool and `C:\wt\a` / `c:/wt/a` are the same directory.
 * Pure — takes the candidate self-paths rather than reading process state.
 */
export function isSelfWorktree(worktreePath, selfPaths) {
  const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const wt = norm(worktreePath);
  return selfPaths.some((candidate) => {
    const c = norm(candidate);
    return c === wt || c.startsWith(`${wt}/`);
  });
}

/**
 * The mandatory refusal reasons, and nothing else — see this file's header
 * for what each one protects and why. All seven fail CLOSED: every `!`-shaped
 * test here reads "could not be confirmed safe", not "was confirmed
 * unsafe". `unpushed` covers BOTH "has commits ahead of its upstream" AND
 * "has no upstream configured at all" (hasUpstream: false).
 *
 * `prQueried: false` is the ONE case that suppresses the PR refusals, and
 * run() sets it only under --prune, and then only for a row that ALREADY
 * carries another refusal — it is a "don't pay for a `gh` round-trip we
 * can't act on" optimisation, never a path to prunable. A row with no other
 * refusal always queries gh, and report mode always queries.
 *
 * Returns an array; empty means the worktree clears every refusal and is
 * eligible for --prune.
 */
export function refusalReasons(facts) {
  const reasons = [];
  if (facts.isPrimary) reasons.push('primary checkout — never pruned');
  if (facts.isSelf) reasons.push('the worktree this process is running from — never pruned');
  if (facts.locked) {
    const why = facts.lockReason ? `: ${facts.lockReason}` : '';
    reasons.push(`locked by \`git worktree lock\`${why}`);
  }
  if (facts.dirty) reasons.push('uncommitted changes');
  if (!facts.mergedIntoMain) reasons.push('not merged into main');
  if (!facts.hasUpstream) reasons.push('no upstream configured — cannot verify it is pushed');
  else if (facts.unpushedCount > 0) reasons.push(`${facts.unpushedCount} unpushed commit(s)`);
  if (facts.prQueried !== false) {
    if (!facts.prAvailable) reasons.push('PR state could not be determined — cannot verify no PR is open');
    else if (facts.prOpen) reasons.push(`open PR #${facts.prNumber}`);
  }
  return reasons;
}

/**
 * Normalise the `ghPrState` verdict into the three states the report and
 * the refusals both need to tell apart: not asked, asked-and-failed, and
 * asked-and-answered (with or without a PR). A missing/`null` verdict is
 * treated as asked-and-failed — the fail-closed reading.
 */
function normalizePrInfo(prInfo) {
  if (prInfo && prInfo.queried === false) {
    return { queried: false, available: false, open: false, number: null, label: 'not queried' };
  }
  if (!prInfo || prInfo.available !== true) {
    return { queried: true, available: false, open: false, number: null, label: 'unknown (gh unavailable)' };
  }
  const pr = prInfo.pr ?? null;
  if (!pr) return { queried: true, available: true, open: false, number: null, label: 'none' };
  return {
    queried: true,
    available: true,
    open: pr.state === 'OPEN',
    number: pr.number,
    label: `#${pr.number} ${pr.state}`,
  };
}

/** Assemble one report row from raw facts + the PR verdict. Pure. */
export function classifyWorktree(tree, facts, prInfo) {
  const pr = normalizePrInfo(prInfo);
  return {
    path: tree.path,
    branch: tree.branch ?? '(detached)',
    mergedIntoMain: facts.mergedIntoMain,
    aheadOfMain: facts.aheadCount,
    dirty: facts.dirty,
    hasUpstream: facts.hasUpstream,
    // null, never a number, when the count could not be read — the row must
    // not claim a count it does not have. `unpushedVerified` is the field to
    // read; `unpushedCount` is only meaningful when it is true.
    unpushedCount: facts.unpushedCount ?? null,
    unpushedVerified: facts.unpushedVerified === true,
    prState: pr.label,
    refusals: refusalReasons({
      ...facts,
      prQueried: pr.queried,
      prAvailable: pr.available,
      prOpen: pr.open,
      prNumber: pr.number,
    }),
  };
}

// ---- The PowerShell -> JS junction-report contract --------------------------

/**
 * The exact property names `Remove-JunctionsRecursive`
 * (scripts/lib/wt-gc-junctions.psm1) puts on every result object, and the
 * ONLY names run() reads. This constant is the JS half of a two-sided pin:
 * scripts/tests/wt-gc.test.mjs asserts the .psm1 source emits each of these,
 * and scripts/tests/wt-gc-junctions.Tests.ps1 asserts this list matches the
 * PowerShell side's own output.
 *
 * Why it is pinned at all: rename `TargetStillExists` on either side and
 * `j.TargetStillExists === false` below becomes permanently false, so the
 * catastrophic case — the junction unlinked AND its real target destroyed —
 * would read as success and `git worktree remove --force` would proceed.
 * validateJunctionEntry() makes that shape fail closed at runtime too.
 */
export const JUNCTION_RESULT_KEYS = ['Path', 'Target', 'Removed', 'TargetStillExists', 'Error'];

/**
 * null when the entry carries every key run() depends on; otherwise a
 * human-readable description of what is wrong. An entry that does not match
 * the contract is a FAILURE, never something to interpret leniently.
 */
export function validateJunctionEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `expected an object, got ${Array.isArray(entry) ? 'an array' : typeof entry}`;
  }
  const missing = JUNCTION_RESULT_KEYS.filter((k) => !Object.hasOwn(entry, k));
  return missing.length === 0 ? null : `missing key(s): ${missing.join(', ')}`;
}

// ---- Fact-gathering (git calls, isolated so the classification above stays pure) --

function gatherFacts(git, tree, isPrimary, isSelf) {
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
  let unpushedVerified = false;
  if (branch && branch !== '(detached)') {
    const upstreamResult = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], {
      cwd: tree.path,
    });
    hasUpstream = upstreamResult.status === 0;
    if (hasUpstream) {
      const upstream = upstreamResult.stdout.trim();
      const unpushedResult = git(['rev-list', '--count', `${upstream}..${branch}`], { cwd: tree.path });
      unpushedCount = unpushedResult.status === 0 ? parseInt(unpushedResult.stdout.trim(), 10) || 0 : null;
      // Couldn't verify — fail closed via refusalReasons, and leave the count
      // NULL rather than a number the row would otherwise be claiming to know.
      if (unpushedCount === null) hasUpstream = false;
      else unpushedVerified = true;
    }
  }
  if (!hasUpstream) unpushedCount = null;

  return {
    isPrimary,
    isSelf,
    // Straight off the porcelain (scripts/wt-list.mjs) — git's own explicit
    // "do not remove this" marker, read BEFORE the destructive step rather
    // than discovered by it.
    locked: tree.locked === true,
    lockReason: tree.lockReason ?? null,
    dirty,
    mergedIntoMain,
    aheadCount,
    hasUpstream,
    unpushedCount,
    unpushedVerified,
  };
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
 * @param {string[]} [opts.selfPaths] paths identifying the worktree this
 *   process is running from — defaults to the script's own repo root plus
 *   the process cwd. Injectable so the self-exclusion refusal is testable
 *   without relocating the test runner.
 * @returns {number} exit code
 */
export function run({ prune, runners, selfPaths = [repoRoot, process.cwd()] }) {
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
    // FAIL CLOSED, like `dirty` and `unpushedCount` beside it: if git could
    // not answer either rev-parse, treat the tree AS the primary checkout.
    // git's own `fatal: is a main working tree` only backstops the LAST
    // step — by then removeJunctions() has already swept the primary
    // checkout's real node_modules/.venv, which is the catastrophic half.
    const isPrimary = commonDir === null || gitDir === null || isPrimaryWorktree(commonDir, gitDir);
    const isSelf = isSelfWorktree(tree.path, selfPaths);

    const facts = gatherFacts(git, tree, isPrimary, isSelf);

    // Under --prune, only spend a `gh` round-trip on a row the answer could
    // change: a row that already carries a refusal cannot become prunable, so
    // querying it buys nothing and costs one serial network call per worktree
    // (17 of them on this box). `prQueried: false` suppresses ONLY the PR
    // refusals, and only for rows already refused on other grounds.
    //
    // In REPORT mode the table is the product, not an input to a decision, so
    // every branched row is queried — the skip made 16 of 18 rows render
    // `not queried` in the PR column, including the open-PR rows that made
    // the pass-1 blocking finding legible in the first place.
    const otherRefusals = refusalReasons({ ...facts, prQueried: false });
    let prInfo;
    if (prune && otherRefusals.length > 0) {
      prInfo = { queried: false, available: false, pr: null };
    } else if (tree.branch && tree.branch !== '(detached)') {
      prInfo = ghPrState(tree.branch);
    } else {
      // No branch to ask about — undeterminable, and refused as such.
      prInfo = { queried: true, available: false, pr: null };
    }
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
      // The report's SHAPE is checked before its content: a renamed or
      // missing key would otherwise make the checks below read as "fine"
      // (`undefined.Removed` is falsy, but `undefined === false` is not, so
      // a renamed TargetStillExists silently passes the catastrophic case).
      const shapeProblem = validateJunctionEntry(j);
      if (shapeProblem !== null) {
        err(`  junction report entry does not match the expected contract (${shapeProblem}): ${JSON.stringify(j)}\n`);
        junctionFailure = true;
        continue;
      }
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
