#!/usr/bin/env node
// `.husky/pre-commit`'s ENTIRE local check (ops-2997, Part 1 of
// docs/superpowers/specs/2026-09-05-commit-gate-rebalance-design.md).
//
// This REPLACES `npm run verify:fast:scoped` (~13,500 tests, a whole vitest
// pool) with one ESLint process over the staged files only. The design's
// load-bearing invariant: no git hook may spawn a process pool. A vitest
// battery is a pool; a single `eslint <files>` process is not.
//
// Must be a script, not inline hook-body shell (per the design doc's
// "The design → Part 1" section): husky runs user hooks as `sh -e "$s"`
// (`.husky/_/h:17`) — under errexit, `FILES=$(git diff … | grep -E …)` fails
// the hook whenever grep matches nothing (no staged JS/TS), and `xargs`
// without `-r` would invoke eslint with zero args, which under the flat
// eslint.config.mjs lints the WHOLE TREE — exactly the pool this script
// exists to avoid.
//
// Principle 4 (fail on findings; pass on a missing tool; pass on a budget
// breach): a worktree without `node_modules` — a normal state here, see
// CLAUDE.md's worktree-setup checklist — must not block a commit; CI still
// enforces lint. An exceeded budget is treated the same way: warn to stderr
// and pass, never hang the commit.
//
// The budget is PER BATCH, not per hook run: `BUDGET_MS` is the `timeout` of
// one `spawnSync`, and a staged set larger than MAX_FILES_PER_BATCH runs
// several of them in sequence. So the worst-case wall clock the hook can add
// is `ceil(files / MAX_FILES_PER_BATCH) × BUDGET_MS`, not BUDGET_MS. That is
// deliberate — a per-run deadline would have to be divided across batches,
// making a large staged set time out on batch size rather than on eslint
// actually being stuck — but it means "60s worst case" is wrong for any
// commit staging more than 100 lintable files.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubGitEnv } from '../git-env.mjs';
import { isDirectlyInvoked } from '../lib/is-main-module.mjs';

// Same extension set `diffSafeForChangedOnly` in verify-cache.mjs uses for
// the `test`/`test:server` --changed narrowing — not reused by import (that
// helper answers a different question), but deliberately the same list.
export const LINTABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export const BUDGET_MS = 60_000;

/** Parse `git diff --cached --name-only --diff-filter=ACMR` stdout into a
 *  list of repo-relative paths, dropping blank lines. */
export function parseStagedFiles(stdoutText) {
  return String(stdoutText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Keep only staged files ESLint's flat config would ever look at. */
export function filterLintableFiles(files) {
  return files.filter((f) => LINTABLE_EXTENSIONS.some((ext) => f.endsWith(ext)));
}

/** Turn a `spawnSync(eslint, ...)` result into a verdict.
 * POSITIVE EVIDENCE that ESLint ran is required before blocking.
 *    { blocked: true,  reason: <human findings> }   — ESLint JSON output with findings
 *    { blocked: false, warning: <string> }          — ESLint did not run or error occurred
 *    { blocked: false }                             — ESLint ran, no findings
 *
 * Principle 4: Pass on missing tool, pass on infra failure, block ONLY on real findings. */
export function classifyLintResult(result) {
  // Any spawn error → ESLint did not run. Pass.
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return { blocked: false, warning: `eslint exceeded its ${BUDGET_MS / 1000}s local budget — skipping (CI still enforces lint).` };
    }
    if (result.error.code === 'ENOENT') {
      return { blocked: false, warning: 'eslint binary not found — skipping local lint (CI still enforces lint).' };
    }
    // Any other spawn error (MODULE_NOT_FOUND via Node, OOM, signal kill, etc.)
    return { blocked: false, warning: `eslint invocation failed (${result.error.code ?? 'unknown error'}) — skipping local lint (CI still enforces lint).` };
  }

  // Exit code 2 = ESLint fatal config/internal error, not lint findings. Pass.
  if (result.status === 2) {
    return { blocked: false, warning: 'eslint reported a fatal configuration error — skipping local lint (CI still enforces lint).' };
  }

  // Try to parse JSON output. If it doesn't parse, ESLint did not run.
  let jsonOutput;
  try {
    jsonOutput = JSON.parse(result.stdout ?? '[]');
  } catch {
    // Node.js or eslint produced non-JSON output (module error, signal, OOM, etc.)
    return { blocked: false, warning: 'eslint did not produce valid JSON output — skipping local lint (CI still enforces lint).' };
  }

  // Stdout must parse as an ARRAY — that, and only that, is the positive
  // evidence that ESLint itself ran. It is NOT the findings signal: ESLint's
  // `--format json` emits one entry per linted file even when the file is
  // completely clean (`messages: []`), so a clean run of one file yields
  // `length === 1`. Reading length as "has findings" blocked every commit
  // that staged a clean JS/TS file.
  if (!Array.isArray(jsonOutput)) {
    return { blocked: false, warning: 'eslint did not produce valid JSON output — skipping local lint (CI still enforces lint).' };
  }

  // The exit code carries the findings signal: 0 = clean, 1 = findings at or
  // above `--max-warnings 0`. (2 = fatal, already handled above.)
  if (result.status === 1) {
    // Reconstruct human-readable output from ESLint JSON for the error message.
    const humanOutput = jsonOutput
      .map((file) => {
        const lines = (file.messages || [])
          .map((msg) => `  ${file.filePath}\n    ${msg.line}:${msg.column}  ${msg.severity}  ${msg.message}`)
          .join('\n');
        return lines ? `${file.filePath}\n${lines}` : '';
      })
      .filter(Boolean)
      .join('\n');
    return { blocked: true, reason: humanOutput };
  }

  // ESLint ran (array parsed) and exited 0. Clean run.
  return { blocked: false };
}

// Batch size for the eslint invocations. The ceiling this respects is
// `CreateProcess`'s 32,767-character command line — NOT the 8,191-char figure
// an earlier version of this comment cited, which is `cmd.exe`'s limit and
// does not apply: `spawnSync` calls `CreateProcess` directly, no shell.
// Measured on this repo, 100 repo-relative paths came to 4,328 characters, so
// 100 leaves a wide margin even for unusually deep paths. The batch size is
// therefore chosen for the per-batch timeout budget above and for bounded
// memory, not because 100 is anywhere near a command-line limit.
export const MAX_FILES_PER_BATCH = 100;

/** Split `files` into batches of at most `size`. */
export function chunkFiles(files, size = MAX_FILES_PER_BATCH) {
  const batches = [];
  for (let i = 0; i < files.length; i += size) {
    batches.push(files.slice(i, i + size));
  }
  return batches;
}

/** Fold one `classifyLintResult` verdict PER BATCH into a single verdict.
 *
 * Batches are classified individually and only their VERDICTS are combined.
 * Aggregating raw stdout instead does not work: concatenating two `--format
 * json` runs yields `[...][...]`, which `JSON.parse` rejects, so every commit
 * staging more than one batch fell into the unparseable-output branch and
 * skipped linting entirely — silently, exactly when the diff was largest.
 * Aggregating raw exit codes has its own bug: a later batch's 2 (fatal) would
 * overwrite an earlier batch's 1, suppressing real findings by accident of
 * batch order.
 *
 * Precedence is explicit and order-independent:
 *   1. ANY batch blocks  → block, reasons from the blocking batches only.
 *   2. else ANY batch warns → pass with that warning (a batch that could not
 *      run is not evidence of findings — principle 4's fail-open direction).
 *   3. else                → pass. */
export function combineBatchVerdicts(verdicts) {
  const blocking = verdicts.filter((v) => v.blocked);
  if (blocking.length > 0) {
    return {
      blocked: true,
      reason: blocking.map((v) => v.reason).filter(Boolean).join('\n'),
    };
  }
  const warned = verdicts.find((v) => v.warning);
  if (warned) {
    return { blocked: false, warning: warned.warning };
  }
  return { blocked: false };
}

/** The whole multi-batch decision: classify each `spawnSync` result on its
 *  own, then fold the verdicts. This is the seam the old raw-stdout /
 *  raw-exit-code aggregation occupied; keeping it a named export means the
 *  regression tests drive exactly the code the hook runs. */
export function combineBatchResults(results) {
  return combineBatchVerdicts(results.map(classifyLintResult));
}

if (isDirectlyInvoked(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');

  const diffResult = spawnSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: scrubGitEnv() },
  );
  const staged = parseStagedFiles(diffResult.stdout ?? '');
  const files = filterLintableFiles(staged).filter((f) => existsSync(join(repoRoot, f)));

  if (files.length === 0) {
    process.exit(0);
  }

  // Pre-check: eslint entry point must exist. If missing, pass (worktree without
  // node_modules is a normal state). This gives us POSITIVE EVIDENCE before trying to spawn.
  const eslintJs = join(repoRoot, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!existsSync(eslintJs)) {
    process.stderr.write('pre-commit-lint: eslint not found — skipping local lint (CI still enforces lint).\n');
    process.exit(0);
  }

  // Run with --format json to verify ESLint produces parseable output (POSITIVE EVIDENCE it ran).
  const baseArgs = ['--format', 'json', '--max-warnings', '0', '--no-warn-ignored'];

  // Batch (see MAX_FILES_PER_BATCH), then classify EACH batch on its own and
  // combine the verdicts. Never aggregate raw stdout or raw exit codes across
  // batches — see combineBatchVerdicts. Note the BUDGET_MS timeout below is
  // per batch, so the hook's worst case is batches × BUDGET_MS.
  const batches = chunkFiles(files);
  const results = [];

  for (const batch of batches) {
    const argv = [eslintJs, ...baseArgs, ...batch];
    results.push(spawnSync(process.execPath, argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: BUDGET_MS,
    }));
  }

  const verdict = combineBatchResults(results);
  if (verdict.warning) {
    process.stderr.write(`pre-commit-lint: ${verdict.warning}\n`);
    process.exit(0);
  }
  if (verdict.blocked) {
    process.stderr.write(verdict.reason);
    process.exit(1);
  }
  process.exit(0);
}
