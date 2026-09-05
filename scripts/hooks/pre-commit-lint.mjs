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
// Principle 4 (fail on findings; pass on a missing tool; FAIL on a budget
// breach): a worktree without `node_modules` — a normal state here, see
// CLAUDE.md's worktree-setup checklist — must not block a commit; CI still
// enforces lint. A 60s local budget that's exceeded is treated the same way:
// warn to stderr and pass, never hang the commit.

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
 *    { blocked: true,  reason: <combined stdout+stderr> }   — real findings
 *    { blocked: false, warning: <string> }                  — infra failure,
 *                                                              pass with a note
 *    { blocked: false }                                     — clean lint
 * A timeout sets `error.code === 'ETIMEDOUT'` (with `signal` also set); a
 * missing binary sets `error.code === 'ENOENT'`. Both must PASS, never block
 * — principle 4. Anything else with a nonzero exit is a real lint finding. */
export function classifyLintResult(result) {
  if (result.error?.code === 'ETIMEDOUT') {
    return { blocked: false, warning: `eslint exceeded its ${BUDGET_MS / 1000}s local budget — skipping (CI still enforces lint).` };
  }
  if (result.error?.code === 'ENOENT') {
    return { blocked: false, warning: 'eslint binary not found — skipping local lint (CI still enforces lint).' };
  }
  if (result.status !== 0) {
    return { blocked: true, reason: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }
  return { blocked: false };
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

  const isWin = process.platform === 'win32';
  const eslintBin = join(repoRoot, 'node_modules', '.bin', isWin ? 'eslint.cmd' : 'eslint');
  const lintArgs = [...files, '--max-warnings', '0'];
  // shell:true is required to exec a .cmd on Windows (spawnSync can't run one
  // directly — EINVAL, same trap eslint-guardrail.test.mjs documents for
  // npx.cmd); shell:true skips Node's own arg quoting, so quote by hand.
  const argv = isWin ? lintArgs.map((a) => `"${a}"`) : lintArgs;
  const result = spawnSync(eslintBin, argv, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: isWin,
    windowsHide: true,
    timeout: BUDGET_MS,
  });

  const verdict = classifyLintResult(result);
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
