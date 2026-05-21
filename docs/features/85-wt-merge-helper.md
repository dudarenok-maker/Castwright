---
status: stable
shipped: 2026-05-21
owner: dudarenok@gmail.com
---

# 85 — `wt-merge.mjs` reconciliation helper

> Status: stable
> Key files: `scripts/wt-merge.mjs`, `scripts/tests/wt-merge.test.mjs`, `CONTRIBUTING.md`
> URL surface: none (CLI tool)
> OpenAPI ops: none

## Benefit / Rationale

- **User (developer):** collapses the 6-step manual "Reconciliation pattern" from CONTRIBUTING.md (cut integration branch, merge, verify, merge, verify, ...) into one command. Previously, the friction of merge-verify-merge-verify discouraged running more than 2 parallel agents on isolated worktrees; the helper unblocks 4-5 agent rounds.
- **Technical:** idempotent — re-running `node scripts/wt-merge.mjs --into <branch> ...` on a partially-merged integration branch resumes from the last successful merge by detecting existing merge commits. Exit-code contract (0/1/2/3) lets CI or wrapper scripts react precisely to validation / conflict / verify failures.
- **Architectural:** wraps the existing primitives (`git merge --no-ff`, `npm run verify`) without introducing new state. The integration branch convention itself is unchanged; the helper just automates the chain. Pairs with plan 59 (parallel Claude Code sessions) and plan 50 (verify-cache) — verify-cache makes the between-merge verify fast enough for this to be practical.

## Architectural impact

- **New surface:** `scripts/wt-merge.mjs` — Node ESM CLI, no external dependencies (only `node:child_process` plus the existing `fast-glob` for the test discovery). Mirrors `scripts/wt-list.mjs` / `scripts/wt-new.mjs` shape (shebang, ESM exports, `main()` + CLI-invocation guard at the bottom). The `runners` injectable object lets the test stub `git` + `npm` without ESM mock acrobatics.
- **No changes** to CONTRIBUTING.md's existing manual recipe — the helper is cross-linked as the automation path; the recipe stays as the documentation of what's happening underneath.
- **Reversibility:** the helper never force-pushes, never bypasses hooks, never operates on `main`. The integration branch is purely local until the user pushes it; aborts on conflict/verify failure print the exact `git merge --abort` / `git reset --merge` commands plus a re-invocation that drops the offending branch.

## Invariants to preserve

1. Refuses to run on a dirty working tree (`scripts/wt-merge.mjs:160-176` → `git status --porcelain` check before any mutation).
2. Idempotent resume — already-merged branches detected via `git log --merges --first-parent --format=%s` and skipped (`scripts/wt-merge.mjs:209-219`, `parseMergedBranchesFromLog` at line 126-133).
3. Exit codes are stable: `0` success / `1` validation (dirty tree, bad args, missing `main`) / `2` merge conflict / `3` verify failure. Callers depend on these.
4. Merge subject is exactly `Merge branch '<branch>' into <integration>` so the resume parser keeps working across runs (`scripts/wt-merge.mjs:271`).
5. Suggested-follow-up command on abort always drops the offending branch and retains the rest (`scripts/wt-merge.mjs:284-291` for conflict, `:306-311` for verify failure).

## Test plan

### Automated coverage

- `scripts/tests/wt-merge.test.mjs` — `node:test` suite via the existing `npm run test:hooks` runner (auto-discovers `scripts/tests/*.test.mjs`):
  - `parseArgs` collects positional branches + picks up `--into` + `--dry-run`; rejects unknown flags and `--into` with no value.
  - `parseMergedBranchesFromLog` extracts quoted branch names from merge-commit subjects + tolerates empty input.
  - `defaultIntegrationBranch` formats `integration/YYYY-MM-DD` with month/day zero-padding.
  - Dry-run prints the plan and never invokes `git` or `npm`; surfaces both branches + the integration name + the `[dry-run]` marker.
  - Empty branches → exit 1 with usage.
  - Dirty working tree → exit 1 with the `Working tree is not clean` banner.
  - Idempotent restart — integration branch already exists with `feat/a` merged; re-invoking `[feat/a, feat/b]` skips `feat/a` and merges only `feat/b`. Log surfaces `Skipping already-merged branches: feat/a`.
  - Conflict abort — `git merge` exits non-zero on `feat/a` → exit 2; stderr lists the conflict files (`src/foo.ts`, `src/bar.ts`) + the `git merge --abort` follow-up; suggested re-invocation omits `feat/a`, retains `feat/b`.
  - Verify abort — `feat/a` merges + verifies green; `feat/b` merges but verify fails → exit 3; stderr surfaces the last lines of verify output + `git reset --merge HEAD~1` follow-up; re-invocation drops `feat/b`, retains `feat/a`.
  - Happy path — both branches merge + verify green; summary lists merged branches in order + final SHA (12 chars) + the `git push -u origin <integration>` next-step hint.

### Manual acceptance walkthrough

1. Spin up four parallel agent branches on disjoint scopes (`feat/scripts-x`, `feat/server-y`, `feat/frontend-z`, `feat/docs-w`).
2. From a clean working tree on any branch: `node scripts/wt-merge.mjs feat/scripts-x feat/server-y feat/frontend-z feat/docs-w`.
3. Expected: a fresh `integration/<today>` branch off `origin/main`; each branch merged via `--no-ff` with the canonical subject; `npm run verify` runs between merges (cached green on warm cache); summary printed at the end with the final SHA + push hint.
4. Re-run the same command → output is `Skipping already-merged branches: feat/scripts-x, feat/server-y, feat/frontend-z, feat/docs-w` (idempotent no-op, exit 0).
5. Force a verify failure on one branch (e.g. introduce a `expect.fail()` in a test only on `feat/server-y`) → exit code 3; stderr names `feat/server-y` + prints the suggested follow-up `node scripts/wt-merge.mjs --into integration/<today> feat/scripts-x feat/frontend-z feat/docs-w`. Running that follow-up drops the offending branch and ships the rest.
6. `--dry-run feat/a feat/b` prints the plan without mutating; exit code 0.

## Out of scope

- Pushing the integration branch and opening the PR — left to the user (the helper prints the suggested `git push` + `gh pr create` line in the summary).
- Conflict resolution itself — the helper aborts on conflict; the user resolves conflicts manually on the source branch then re-runs the helper (or drops that branch).
- Cross-platform shells — runner already handles `win32` `npm.cmd` vs POSIX `npm`; `git` works the same on both since it's a real binary.

## Ship notes

Shipped 2026-05-21 — closes BACKLOG Could #11. Lands `scripts/wt-merge.mjs` (Node ESM CLI), `scripts/tests/wt-merge.test.mjs` (node:test suite via the existing `npm run test:hooks` auto-discovery), and a cross-link from CONTRIBUTING.md's "Reconciliation pattern" section. No npm script additions needed — the test file is auto-picked up by `scripts/run-hooks-tests.mjs` via fast-glob.
