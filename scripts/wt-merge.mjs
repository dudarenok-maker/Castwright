#!/usr/bin/env node
// Automate CONTRIBUTING.md "Reconciliation pattern" — cut a fresh
// integration/<date> branch off main, merge each agent branch one at a time,
// run `npm run verify` between merges, abort with clear next-steps on any
// conflict or verify failure.
//
// Usage:
//   node scripts/wt-merge.mjs <branch> [<branch>...] [--into integration/<name>] [--dry-run]
//
// Example:
//   node scripts/wt-merge.mjs feat/server-foo feat/frontend-bar
//   node scripts/wt-merge.mjs feat/a feat/b feat/c feat/d --into integration/2026-05-21
//   node scripts/wt-merge.mjs --dry-run feat/foo feat/bar
//
// What it does:
//   1. Validates the working tree is clean (refuses to merge dirty trees).
//   2. `git fetch origin main`.
//   3. Resolves the integration branch — `--into <name>` if provided, else
//      `integration/<YYYY-MM-DD>`. If the branch already exists locally,
//      checks it out and resumes; otherwise `git switch -c <name> origin/main`.
//   4. Reads existing merge commits on the integration branch and skips any
//      branches whose merge is already present (idempotent restart).
//   5. For each remaining branch: `git fetch origin <branch>`,
//      `git merge --no-ff <branch>`, then `npm run verify`. Aborts loudly on
//      conflict (exit 2) or verify failure (exit 3) with the suggested
//      follow-up command.
//   6. Prints a summary with the integration branch name, merged branches in
//      order, the final SHA, and a reminder to push + open one PR.
//
// Exit codes:
//   0 — success (all branches merged, all verifies green) or no-op dry run.
//   1 — validation failure (dirty tree, bad args, missing main, etc).
//   2 — merge conflict on one of the agent branches.
//   3 — `npm run verify` failed after one of the merges.
//
// All git/npm invocations route through an injectable `runners` object so
// tests can stub them without ESM mock acrobatics.

import { spawnSync } from 'node:child_process';

// ---- Argument parsing -------------------------------------------------------

export function parseArgs(argv) {
  const args = { branches: [], into: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--into') {
      args.into = argv[++i];
      if (!args.into) throw new Error('--into requires a value');
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      args.branches.push(a);
    }
  }
  return args;
}

function usage(extra) {
  const lines = [
    'Usage: node scripts/wt-merge.mjs <branch> [<branch>...] [--into integration/<name>] [--dry-run]',
    '',
    'Example:',
    '  node scripts/wt-merge.mjs feat/server-foo feat/frontend-bar',
    '  node scripts/wt-merge.mjs --dry-run feat/a feat/b',
    '',
    'See CONTRIBUTING.md "Reconciliation pattern" for the manual recipe this automates.',
  ];
  if (extra) lines.unshift(`Error: ${extra}`, '');
  return lines.join('\n');
}

// ---- Default runners (real git / real npm) ---------------------------------

export function makeDefaultRunners() {
  return {
    git(args, opts = {}) {
      const result = spawnSync('git', args, { encoding: 'utf8', ...opts });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
      };
    },
    npm(args, opts = {}) {
      // `npm` on Windows is a .cmd shim; spawnSync needs shell:true there.
      const isWindows = process.platform === 'win32';
      const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', args, {
        encoding: 'utf8',
        ...opts,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
      };
    },
    log(text) {
      process.stdout.write(text);
    },
    err(text) {
      process.stderr.write(text);
    },
  };
}

// ---- Default integration branch name ---------------------------------------

export function defaultIntegrationBranch(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `integration/${y}-${m}-${d}`;
}

// ---- Parse already-merged branches from `git log --merges --format='%s'` ----

// Subjects look like: "Merge branch 'feat/foo' into integration/2026-05-21"
// We extract the quoted branch name.
export function parseMergedBranchesFromLog(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^Merge branch '([^']+)'/);
    if (m) out.push(m[1]);
  }
  return out;
}

// ---- The runner ------------------------------------------------------------

/**
 * Drive the reconciliation. Returns an exit code (0/1/2/3); never throws on
 * recoverable git/npm failures — those collapse to a printed message + a
 * non-zero exit code so the CLI surface stays predictable.
 *
 * @param {Object} opts
 * @param {string[]} opts.branches - Agent branches to merge, in order.
 * @param {string|null} opts.into - Integration branch name override (else default).
 * @param {boolean} opts.dryRun - If true, print the plan without mutating.
 * @param {Object} opts.runners - { git, npm, log, err } injectable runners.
 * @param {Date}   [opts.now] - Used for defaulting the integration branch name.
 */
export function runMerge({ branches, into, dryRun, runners, now }) {
  const { git, npm, log, err } = runners;

  if (!branches || branches.length === 0) {
    err(usage('at least one branch argument is required') + '\n');
    return 1;
  }

  const integration = into ?? defaultIntegrationBranch(now);

  // --- Validation: working tree clean ---
  if (!dryRun) {
    const status = git(['status', '--porcelain']);
    if (status.error) {
      err(`git status failed: ${status.error.message}\n`);
      return 1;
    }
    if (status.status !== 0) {
      err(`git status exited ${status.status}:\n${status.stderr || status.stdout}\n`);
      return 1;
    }
    if (status.stdout.trim().length > 0) {
      err(
        'Working tree is not clean. Commit, stash, or discard changes before running wt-merge.\n' +
          `git status --porcelain output:\n${status.stdout}\n`,
      );
      return 1;
    }
  }

  // --- Fetch latest main ---
  if (dryRun) {
    log(`[dry-run] git fetch origin main\n`);
  } else {
    const fetched = git(['fetch', 'origin', 'main']);
    if (fetched.error || fetched.status !== 0) {
      err(
        `git fetch origin main failed (status ${fetched.status}):\n${fetched.stderr || fetched.stdout}\n`,
      );
      return 1;
    }
  }

  // --- Resolve integration branch (exists locally? resume; else create) ---
  let alreadyMerged = [];
  if (dryRun) {
    log(`[dry-run] checkout/create integration branch: ${integration}\n`);
  } else {
    const existsLocal = git(['rev-parse', '--verify', '--quiet', `refs/heads/${integration}`]);
    if (existsLocal.status === 0) {
      // Resume on existing branch.
      const checkout = git(['checkout', integration]);
      if (checkout.error || checkout.status !== 0) {
        err(
          `git checkout ${integration} failed:\n${checkout.stderr || checkout.stdout}\n`,
        );
        return 1;
      }
      log(`Resuming on existing integration branch: ${integration}\n`);

      // Detect already-merged branches via merge commits on this branch.
      const logged = git([
        'log',
        '--merges',
        '--first-parent',
        '--format=%s',
        `origin/main..${integration}`,
      ]);
      if (logged.status === 0) {
        alreadyMerged = parseMergedBranchesFromLog(logged.stdout);
      }
    } else {
      // Create fresh off origin/main.
      const switched = git(['switch', '-c', integration, 'origin/main']);
      if (switched.error || switched.status !== 0) {
        err(
          `git switch -c ${integration} origin/main failed:\n${switched.stderr || switched.stdout}\n`,
        );
        return 1;
      }
      log(`Created integration branch: ${integration} (off origin/main)\n`);
    }
  }

  // --- Plan: filter out already-merged branches ---
  const skipped = [];
  const planned = [];
  for (const branch of branches) {
    if (alreadyMerged.includes(branch)) skipped.push(branch);
    else planned.push(branch);
  }
  if (skipped.length > 0) {
    log(`Skipping already-merged branches: ${skipped.join(', ')}\n`);
  }

  if (dryRun) {
    log(`\nPlan:\n`);
    log(`  Integration branch: ${integration}\n`);
    log(`  Branches to merge:  ${planned.join(', ') || '(none — all already merged)'}\n`);
    if (skipped.length > 0) log(`  Skipped (merged):   ${skipped.join(', ')}\n`);
    log(`  Per branch: git fetch origin <branch> -> git merge --no-ff <branch> -> npm run verify\n`);
    log(`\n[dry-run] no mutations performed.\n`);
    return 0;
  }

  // --- Merge loop ---
  const merged = [];
  for (const branch of planned) {
    log(`\n=== Merging ${branch} into ${integration} ===\n`);

    // Fetch the agent branch to ensure local ref is fresh.
    const fetched = git(['fetch', 'origin', branch]);
    if (fetched.error || fetched.status !== 0) {
      err(
        `git fetch origin ${branch} failed (status ${fetched.status}):\n${fetched.stderr || fetched.stdout}\n`,
      );
      err(`Suggested follow-up: confirm '${branch}' exists on origin, then retry.\n`);
      return 1;
    }

    // Merge --no-ff so the merge commit subject persists across runs and
    // parseMergedBranchesFromLog can detect already-merged branches on restart.
    const msg = `Merge branch '${branch}' into ${integration}`;
    const mergeRef = `origin/${branch}`;
    const merge = git(['merge', '--no-ff', mergeRef, '-m', msg]);
    if (merge.error || merge.status !== 0) {
      // Detect conflict file list.
      const conflicts = git(['diff', '--name-only', '--diff-filter=U']);
      const conflictFiles = (conflicts.stdout || '').split(/\r?\n/).filter(Boolean);
      err(`\nMerge of '${branch}' into ${integration} FAILED (status ${merge.status}).\n`);
      if (merge.stderr) err(merge.stderr + '\n');
      if (conflictFiles.length > 0) {
        err(`Conflict files (${conflictFiles.length}):\n`);
        for (const f of conflictFiles) err(`  - ${f}\n`);
      }
      err(
        `\nSuggested follow-up:\n` +
          `  git merge --abort\n` +
          `  node scripts/wt-merge.mjs --into ${integration} ${planned
            .filter((b) => b !== branch)
            .join(' ')}\n` +
          `(drops '${branch}' from the batch; re-cut that branch off the new main later)\n`,
      );
      return 2;
    }

    // Run verify between merges.
    log(`Merge OK. Running npm run verify...\n`);
    const verify = npm(['run', 'verify']);
    if (verify.error || verify.status !== 0) {
      // Tail last 30 lines of stderr+stdout for context.
      const combined = `${verify.stdout || ''}${verify.stderr || ''}`;
      const lines = combined.split(/\r?\n/);
      const tail = lines.slice(Math.max(0, lines.length - 30)).join('\n');
      err(`\nnpm run verify FAILED after merging '${branch}' (status ${verify.status}).\n`);
      err(`Last 30 lines of verify output:\n${tail}\n`);
      err(
        `\nSuggested follow-up:\n` +
          `  git reset --merge HEAD~1   # undo the failing merge\n` +
          `  node scripts/wt-merge.mjs --into ${integration} ${planned
            .filter((b) => b !== branch)
            .join(' ')}\n` +
          `(drops '${branch}' from the batch; investigate the verify failure separately)\n`,
      );
      return 3;
    }
    merged.push(branch);
  }

  // --- Summary ---
  const head = git(['rev-parse', 'HEAD']);
  const finalSha = head.status === 0 ? head.stdout.trim().slice(0, 12) : '(unknown)';

  log(`\n=== Reconciliation complete ===\n`);
  log(`Integration branch: ${integration}\n`);
  log(`Merged in order:    ${merged.length > 0 ? merged.join(', ') : '(none — all skipped)'}\n`);
  if (skipped.length > 0) log(`Skipped (resumed):  ${skipped.join(', ')}\n`);
  log(`Final SHA:          ${finalSha}\n`);
  log(`\nNext: push the integration branch and open one PR:\n`);
  log(`  git push -u origin ${integration}\n`);
  log(`  gh pr create --title "chore: reconcile ${integration}" ...\n`);

  return 0;
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
  return runMerge({
    branches: args.branches,
    into: args.into,
    dryRun: args.dryRun,
    runners,
  });
}

const invokedAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/wt-merge.mjs');

if (invokedAsCli) {
  process.exit(main());
}
