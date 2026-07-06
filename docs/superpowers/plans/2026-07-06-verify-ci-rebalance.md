# Verify / CI Rebalance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop routine local `npm run verify` runs from self-contending on
the dev box by moving the heavy legs to a now-free, opt-out cloud CI gate,
while keeping the local machine automatically covering the one thing it
alone can do (scope-gated sidecar tests).

**Architecture:** A new `--scope-branch` mode in `scripts/verify-cache.mjs`
(diffing the branch vs local `main`, reusing the existing uniform per-step
scope-filter engine) powers a new `verify:fast:branch` npm script that
replaces `npm run verify` in `.husky/pre-push`. `.github/workflows/verify.yml`
flips from label-gated opt-in to opt-out-by-default and gains two previously
cloud-uncovered legs (`config:check`, `test:pinokio`) plus two scope-matcher
fixes; it also gets wired into `main`'s required-status-check ruleset (the
one manual, non-subagent step). `cross-os.yml`'s cron doubles up. Docs
(`CLAUDE.md`, `CONTRIBUTING.md`, `docs/features/118`/`215`/`235`) are updated
to describe the new posture.

**Tech Stack:** Node.js (`node:test`, `node:child_process`), GitHub Actions
YAML, Bash (workflow `run:` steps), Husky git hooks, Markdown docs.

## Global Constraints

- Every commit message follows `<type>(<scope>): <subject>` (CLAUDE.md commit
  convention) — this work is `chore(scripts)` / `ci` / `docs` scoped, per
  file touched.
- No placeholders, no deferred "add tests later" — every code task ships its
  own paired test in the same commit (CLAUDE.md testing discipline).
- Reference doc for every design decision below:
  `docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md` (already
  merged through 3 rounds of adversarial review) — don't re-derive or
  second-guess a decision it already settled; if something here seems to
  contradict it, the spec wins and this plan has a bug.
- Work happens on branch `docs/verify-ci-rebalance-design` (already checked
  out, already has the spec's 3 commits). Continue committing there.

---

### Task 1: `--scope-branch` mode + `branchDiffFiles` in `verify-cache.mjs`

**Files:**
- Modify: `scripts/verify-cache.mjs`
- Modify: `scripts/tests/verify-cache.test.mjs`
- Modify: `package.json` (new `verify:fast:branch` script)

**Interfaces:**
- Produces: `parseFlags(argv)` return shape gains a `scopeBranch: boolean`
  field (alongside existing `noCache`, `steps`, `scopeStaged`).
- Produces: `export function branchDiffFiles(cwd)` — returns `string[]`
  (POSIX-relative paths) on success (including an empty array for a
  legitimate zero-file diff), or `null` if the underlying git commands
  fail. Mirrors `stagedDiffFiles`'s contract but is exported (that one
  isn't) specifically so it's independently unit-testable.
- Consumes (Task 2 depends on this): the new `verify:fast:branch` npm
  script, which Task 2's `.husky/pre-push` edit calls.

- [ ] **Step 1: Write the failing tests**

Open `scripts/tests/verify-cache.test.mjs`. First, add `branchDiffFiles` to
the import list at the top of the file:

```js
import {
  composeInputHash,
  decide,
  hashFile,
  hashEntries,
  loadCache,
  saveCache,
  parseFlags,
  selectStepFiles,
  stepTouchedByDiff,
  computeShared,
  parseNvidiaSmiUtil,
  isVitestPoolCrash,
  branchDiffFiles,
  STEPS,
  _internals,
} from '../verify-cache.mjs';
```

Then replace the entire `parseFlags` test block (currently the 11 tests
between `test('parseFlags recognizes --no-cache anywhere in argv', ...)` and
`test('parseFlags recognizes --scope-staged', ...)`, i.e. lines 197-273 of
the current file) with this — every existing assertion gains the new
`scopeBranch: false` key, and one new test is added at the end:

```js
test('parseFlags recognizes --no-cache anywhere in argv', () => {
  assert.deepEqual(parseFlags([]), {
    noCache: false,
    steps: null,
    scopeStaged: false,
    scopeBranch: false,
  });
  assert.deepEqual(parseFlags(['--no-cache']), {
    noCache: true,
    steps: null,
    scopeStaged: false,
    scopeBranch: false,
  });
  assert.deepEqual(parseFlags(['a', 'b', '--no-cache', 'c']), {
    noCache: true,
    steps: null,
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags --steps with space-separated form', () => {
  assert.deepEqual(parseFlags(['--steps', 'test:hooks,test,test:server']), {
    noCache: false,
    steps: ['test:hooks', 'test', 'test:server'],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags --steps with = form', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks,test,test:server']), {
    noCache: false,
    steps: ['test:hooks', 'test', 'test:server'],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags --steps trims whitespace and drops empty segments', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks , , test']), {
    noCache: false,
    steps: ['test:hooks', 'test'],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags --steps combines with --no-cache', () => {
  assert.deepEqual(parseFlags(['--steps=test:hooks,test', '--no-cache']), {
    noCache: true,
    steps: ['test:hooks', 'test'],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags missing --steps argument yields empty list (caller errors out)', () => {
  // `--steps` with no following arg, or followed by another `--flag`, is a
  // user-error case that runPipeline surfaces as a non-zero exit rather than
  // silently running the full pipeline.
  assert.deepEqual(parseFlags(['--steps']), {
    noCache: false,
    steps: [],
    scopeStaged: false,
    scopeBranch: false,
  });
  assert.deepEqual(parseFlags(['--steps', '--no-cache']), {
    noCache: true,
    steps: [],
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags absent --steps leaves steps null (full pipeline)', () => {
  assert.deepEqual(parseFlags(['some', 'other', 'arg']), {
    noCache: false,
    steps: null,
    scopeStaged: false,
    scopeBranch: false,
  });
});

test('parseFlags recognizes --scope-staged', () => {
  assert.deepEqual(parseFlags(['--scope-staged']), {
    noCache: false,
    steps: null,
    scopeStaged: true,
    scopeBranch: false,
  });
});

test('parseFlags recognizes --scope-branch', () => {
  assert.deepEqual(parseFlags(['--scope-branch']), {
    noCache: false,
    steps: null,
    scopeStaged: false,
    scopeBranch: true,
  });
});
```

Finally, add a new section at the very end of the file (after the last
`parseNvidiaSmiUtil` test) for `branchDiffFiles`:

```js
// --- Branch-diff scope filter (verify/CI rebalance, 2026-07-06) --------

function gitAt(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

// Builds a throwaway repo with one commit on a `main` branch, so tests can
// exercise branchDiffFiles' real `git merge-base` + `git diff` calls without
// touching this actual repo.
function makeGitFixture() {
  const dir = mkTmp();
  gitAt(dir, ['init', '-q', '-b', 'main']);
  gitAt(dir, ['config', 'user.email', 'test@example.com']);
  gitAt(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'base.txt'), 'base', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

test('branchDiffFiles: returns files changed since branching off main', () => {
  const dir = makeGitFixture();
  gitAt(dir, ['switch', '-q', '-c', 'feature']);
  writeFileSync(join(dir, 'feature.txt'), 'x', 'utf8');
  gitAt(dir, ['add', '.']);
  gitAt(dir, ['commit', '-q', '-m', 'feature commit']);
  const files = branchDiffFiles(dir);
  assert.deepEqual(files, ['feature.txt']);
});

test('branchDiffFiles: empty array (not null) when run directly on main with nothing new', () => {
  const dir = makeGitFixture();
  const files = branchDiffFiles(dir);
  assert.deepEqual(files, []);
});

test('branchDiffFiles: returns null when cwd is not a git repo', () => {
  const dir = mkTmp(); // no git init — merge-base has nothing to find
  const files = branchDiffFiles(dir);
  assert.equal(files, null);
});
```

This last block needs `spawnSync` in scope — add it to the existing
`node:child_process` import at the top of the test file (currently the file
only imports from `node:fs`, `node:os`, `node:path`; add a new import line):

```js
import { spawnSync } from 'node:child_process';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:hooks`
Expected: FAIL — `branchDiffFiles is not a function` (not exported yet) and
`parseFlags` deepEqual mismatches (missing `scopeBranch` key).

- [ ] **Step 3: Implement `scopeBranch` in `parseFlags`**

In `scripts/verify-cache.mjs`, find `parseFlags`'s return statement:

```js
  return {
    noCache: argv.includes('--no-cache'),
    steps,
    scopeStaged: argv.includes('--scope-staged'),
  };
```

Replace with:

```js
  return {
    noCache: argv.includes('--no-cache'),
    steps,
    scopeStaged: argv.includes('--scope-staged'),
    scopeBranch: argv.includes('--scope-branch'),
  };
```

- [ ] **Step 4: Implement `branchDiffFiles`**

In `scripts/verify-cache.mjs`, find the existing `stagedDiffFiles` function:

```js
// Files staged for commit. Returns POSIX paths, or null if git fails (→ caller
// disables the scope filter and runs everything; never skip on uncertainty).
function stagedDiffFiles(cwd) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosix);
}
```

Immediately after it, add:

```js
// Files touched by every commit on the current branch since it diverged
// from local `main` — the right basis for a pre-push-time check, where
// "staged" is usually empty (commits already exist). Returns POSIX paths,
// or null if the underlying git commands fail (→ caller disables the scope
// filter and runs everything; never skip on uncertainty). Distinct from
// that failure case: a SUCCESSFUL merge-base+diff that finds no changed
// files (branch fully merged into main, running directly on main, or a
// commit-less branch) legitimately returns an empty array — the scope
// filter correctly skips every step for that, which is fine given
// verify.yml is now the required backstop. Exported (unlike
// stagedDiffFiles) so it can be unit-tested directly.
export function branchDiffFiles(cwd) {
  const base = spawnSync('git', ['merge-base', 'HEAD', 'main'], {
    cwd,
    encoding: 'utf8',
  });
  if (base.error || base.status !== 0) return null;
  const baseSha = base.stdout.trim();
  const r = spawnSync('git', ['diff', '--name-only', baseSha, 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosix);
}
```

- [ ] **Step 5: Wire `--scope-branch` into `runPipeline`**

In `scripts/verify-cache.mjs`, find the scope-filter block inside
`runPipeline`:

```js
  // Scope filter (pre-commit) — compute the staged diff once; per-step skip
  // happens at the top of the loop below.
  let scopeDiff = null;
  let scopeShared = false;
  if (flags.scopeStaged) {
    scopeDiff = stagedDiffFiles(cwd);
    if (scopeDiff === null) {
      console.log('[scope] git diff --cached failed; running all selected steps');
    } else if (computeShared(scopeDiff)) {
      scopeShared = true;
      console.log('[scope] root manifest changed — all selected steps in scope');
    }
  }
```

Replace with:

```js
  // Scope filter (pre-commit / pre-push) — compute the diff once; per-step
  // skip happens at the top of the loop below. --scope-staged (staged diff)
  // and --scope-branch (branch-vs-main diff) are mutually exclusive scope
  // bases feeding the SAME per-step filter.
  let scopeDiff = null;
  let scopeShared = false;
  if (flags.scopeStaged) {
    scopeDiff = stagedDiffFiles(cwd);
    if (scopeDiff === null) {
      console.log('[scope] git diff --cached failed; running all selected steps');
    } else if (computeShared(scopeDiff)) {
      scopeShared = true;
      console.log('[scope] root manifest changed — all selected steps in scope');
    }
  } else if (flags.scopeBranch) {
    scopeDiff = branchDiffFiles(cwd);
    if (scopeDiff === null) {
      console.log('[scope] git merge-base/diff against main failed; running all selected steps');
    } else if (scopeDiff.length === 0) {
      console.log('[scope] no diff vs main — nothing in scope, selected steps will skip');
    } else if (computeShared(scopeDiff)) {
      scopeShared = true;
      console.log('[scope] root manifest changed — all selected steps in scope');
    }
  }
```

No other change is needed — the existing loop condition
(`if (scopeDiff !== null && !scopeShared && !stepTouchedByDiff(step, scopeDiff))`)
already correctly skips every step when `scopeDiff` is `[]`, since
`stepTouchedByDiff` returns `false` for an empty diff list (already covered
by the existing test `'stepTouchedByDiff: an empty diff touches nothing'`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:hooks`
Expected: PASS — all tests green, including the 3 new `branchDiffFiles`
tests and the updated `parseFlags` tests.

- [ ] **Step 7: Add the `verify:fast:branch` npm script**

In `package.json`, find this line (in the `scripts` block):

```json
    "verify:fast:scoped": "node scripts/verify-cache.mjs --steps test:hooks,test,test:server --scope-staged",
```

Add immediately after it:

```json
    "verify:fast:branch": "node scripts/verify-cache.mjs --steps lint,typecheck,config:check,test:hooks,test,test:server,build,test:sidecar --scope-branch",
```

- [ ] **Step 8: Manually spot-check the new script**

Run: `npm run verify:fast:branch`
Expected: since this branch (`docs/verify-ci-rebalance-design`) so far only
touches `docs/superpowers/specs/**` and (after this task) `scripts/`,
`package.json`, `scripts/tests/**` — steps whose scope includes those paths
run (e.g. `test:hooks` since it now covers `scripts/tests/*.test.mjs`);
steps like `test:sidecar` (scope `server/tts-sidecar/**`) print
`[skip] test:sidecar (out of scope)`. Confirm no step errors out and the
scope decisions look sane in the printed `[skip]`/`[run]` lines.

- [ ] **Step 9: Commit**

```bash
git add scripts/verify-cache.mjs scripts/tests/verify-cache.test.mjs package.json
git commit -m "feat(scripts): add --scope-branch mode to verify-cache for branch-diff-scoped pre-push checks"
```

---

### Task 2: Wire `.husky/pre-push` to `verify:fast:branch`

**Files:**
- Modify: `.husky/pre-push`

**Interfaces:**
- Consumes: `npm run verify:fast:branch` (Task 1).

- [ ] **Step 1: Replace the pre-push hook body**

Read the current `.husky/pre-push` (10 lines of guard comments + 6 lines of
script). Replace the entire file content with:

```bash
# Pre-push guards run before the fast branch-scoped check. git pipes the
# pushed-ref list on stdin; capture it ONCE and feed all three checks (stdin
# can only be read once). Bypass intentionally with `git push --no-verify`.
#   1. guard-protected-push  — refuse force-push / deletion of main (#163).
#   2. guard-commit-subjects — reject any pushed commit whose subject violates
#      the Conventional-Commits rule, even if commit-msg was bypassed
#      (--no-verify / worktree hook couldn't spawn). Backstops the @-leak that
#      shipped on #856.
#   3. is-docs-only-push     — skip the local check entirely when every
#      changed file is docs (same test as CONTRIBUTING.md's CI doc-only
#      fast-path) — a docs-only diff has no runtime surface to exercise.
#
# The heavy legs (e2e, server-slow, scripts/Pester, build's full battery,
# etc.) no longer run locally on every push — cloud `verify.yml` is now a
# required status check covering them (see
# docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md).
# `verify:fast:branch` runs only the fast/cheap steps, each scope-gated to
# whether this branch's diff (vs local `main`) actually touches its inputs —
# including `test:sidecar`, scope-gated to `server/tts-sidecar/**`, so the
# one check that genuinely needs this machine still runs automatically
# exactly when it's relevant.
PUSH_REFS=$(cat)
printf '%s\n' "$PUSH_REFS" | node scripts/guard-protected-push.mjs "$@" || exit 1
printf '%s\n' "$PUSH_REFS" | node scripts/guard-commit-subjects.mjs "$@" || exit 1
if printf '%s\n' "$PUSH_REFS" | node scripts/is-docs-only-push.mjs "$@"; then
  exit 0
fi
npm run verify:fast:branch
```

- [ ] **Step 2: Manually verify the hook fires correctly**

Run: `git add -A && git commit -m "test: dummy commit for hook check" --allow-empty` (a throwaway empty commit — do NOT push it)
Then run: `bash .husky/pre-push <<< "refs/heads/docs/verify-ci-rebalance-design"`
Expected: the guard scripts run, then `npm run verify:fast:branch` runs
(same scope-filtered output as Task 1 Step 8), exiting 0 on success.
Then run: `git reset --hard HEAD~1` to remove the throwaway commit (it was
never pushed, so this is safe and doesn't touch the real commit history).

- [ ] **Step 3: Commit**

```bash
git add .husky/pre-push
git commit -m "fix(scripts): swap pre-push from full verify to branch-scoped fast check"
```

---

### Task 3: `.github/workflows/verify.yml` — opt-out, required-check-ready, new legs

**Files:**
- Modify: `.github/workflows/verify.yml`

**Interfaces:**
- Produces: the `npm run verify` job name (unchanged) — Task 8 (manual
  ruleset step) binds to this exact job name.
- No code interface — this is a workflow YAML file, verified by reading the
  diff carefully and (optionally) a `workflow_dispatch` run once pushed.

- [ ] **Step 1: Replace the file header (top-of-file comment block, `on:` block through `permissions:`)**

Replace lines 1–49 (from `name: Verify` through `permissions:\n  contents: read`) with:

```yaml
name: Verify

# Plan 60 — CI verify-on-PR. Plan 103 — per-PR cost reduction. Plan 215 — CI
# was opt-in (label-gated) while the repo was private and Actions minutes
# were metered. See docs/superpowers/specs/2026-07-06-verify-ci-rebalance-
# design.md: the repo is now public (free, uncapped Actions minutes on
# standard runners), and local `npm run verify` was causing multi-hour
# self-contention on the dev box, so this workflow flips from opt-in to
# OPT-OUT (runs on every PR by default) AND becomes a required status check
# on `main`'s branch-protection ruleset — closing the gap where local
# pre-push was previously the only thing that refused to push on a red leg.
#
# It runs only the LEGS whose scope actually changed. A single job does setup
# once, detects which scopes the PR touched (git diff against the PR base),
# then gates each expensive leg (server tests, e2e, build, …) behind an `if:`
# on that scope. A PR that touches only `src/**` skips the server tests; a
# server-only PR skips the frontend unit suite + Playwright e2e; etc. Local
# pre-push now only runs a fast, branch-diff-scoped subset
# (`verify:fast:branch`) — this cloud run is the actual enforcement gate for
# everything else, not redundant insurance.
#
# Why one job with conditional steps (not a job-per-leg matrix): GitHub bills
# each job's wall-clock separately, summed, rounded UP to the minute per job.
# Parallel jobs would duplicate `npm ci` + pay a 1-min floor each. One job →
# setup paid once, skipped legs cost ~0. (Billing is no longer the primary
# driver now that Actions minutes are free on this public repo, but the
# single-job shape is still the simpler design.)
#
# No `paths-ignore` here (deliberately removed — see design spec): keeping it
# while this is a required status check would deadlock every docs-only PR,
# since a required check that never fires blocks merge forever. Every leg's
# own `if:` scope condition already evaluates false for a docs-only diff, so
# the job still completes in roughly the time of "Setup Node + deps" alone
# and reports green — no deadlock, negligible added time. Same reasoning is
# why the job no longer gates on PR `draft` status either — a draft-gated
# required check would deadlock every draft PR the same way.

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]
  # Manual on-demand run: Actions tab → Verify → Run workflow, or
  # `gh workflow run verify.yml --ref <branch>`. A dispatch has no PR diff to
  # scope against, so it runs the FULL battery (every leg) — see the scope
  # detector below.
  workflow_dispatch:

permissions:
  contents: read
```

- [ ] **Step 2: Replace the job header (`jobs:` through the `timeout-minutes` line)**

Find:

```yaml
jobs:
  verify:
    # NOTE: the `name:` "npm run verify" is the historical status-check name.
    # Branch protection on `main` deliberately does NOT require it as a status
    # check (the staged ruleset excludes required checks so opt-in/doc-only PRs
    # can't deadlock — see brand/ruleset-main.json / com-4), so a no-op run on
    # an unlabeled PR never blocks merge. Keep the name stable anyway in case a
    # required check is added later.
    name: npm run verify
    runs-on: ubuntu-latest
    # Opt-in gate: run ONLY on a manual dispatch, or a non-draft PR carrying
    # the `run-ci` label. Unlabeled PRs evaluate the workflow but the job is
    # skipped here → zero runner minutes billed. Local pre-push already runs
    # the full battery, so this cloud run is on-demand insurance.
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.pull_request.draft == false &&
       contains(github.event.pull_request.labels.*.name, 'run-ci'))
    # 30 (was 20): a run that dies AT the cap bills the full cap for nothing and
```

Replace with:

```yaml
jobs:
  verify:
    # NOTE: the `name:` "npm run verify" is the historical status-check name.
    # This check IS required on `main`'s branch-protection ruleset (see the
    # design spec) — keep this name stable, since renaming the job would
    # silently detach the required-check rule from it.
    name: npm run verify
    runs-on: ubuntu-latest
    # 30 (was 20): a run that dies AT the cap bills the full cap for nothing and
```

(The job now has no `if:` gate at all — it runs unconditionally whenever the
`on:` trigger fires. Everything after `timeout-minutes: 30` through the
`Checkout` step stays exactly as-is; only this header block changes.)

- [ ] **Step 3: Update the scope-detection step**

Find the `Detect changed scopes` step's `run:` block:

```yaml
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            for k in frontend server sidecar e2e scripts hooks shared; do
              echo "$k=true" >> "$GITHUB_OUTPUT"
              echo "scope $k=true (workflow_dispatch → full run)"
            done
            exit 0
          fi
          BASE="${{ github.event.pull_request.base.sha }}"
          HEAD="${{ github.event.pull_request.head.sha }}"
          FILES="$(git diff --name-only "$BASE" "$HEAD")"
          echo "Changed files in this PR:"
          echo "$FILES"
          echo "---"
          match() { echo "$FILES" | grep -qE "$1"; }
          frontend=false; server=false; sidecar=false
          e2e=false; scripts=false; hooks=false; shared=false
          match '^(src/|index\.html$|vite\.config\.ts$|tailwind\.config\.ts$|tsconfig\.json$|tsconfig\.node\.json$|postcss\.config\.js$|eslint\.config\.(js|mjs)$)' && frontend=true
          match '^(server/src/|server/package(-lock)?\.json$|server/tsconfig\.json$|server/vitest\.config(\.slow)?\.ts$|openapi\.yaml$)' && server=true
          match '^server/tts-sidecar/' && sidecar=true
          match '^(e2e/|playwright\.config\.ts$)' && e2e=true
          match '^scripts/' && scripts=true
          match '^(\.husky/|scripts/run-hooks-tests\.mjs$|scripts/validate-commit-msg\.mjs$)' && hooks=true
          # `shared` = a ROOT dependency manifest changed → treat as global
          # (a dep/lockfile bump can affect every leg), so run everything.
          match '^(package\.json|package-lock\.json)$' && shared=true
          for k in frontend server sidecar e2e scripts hooks shared; do
            echo "$k=${!k}" >> "$GITHUB_OUTPUT"
            echo "scope $k=${!k}"
          done
```

Replace with:

```yaml
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            for k in frontend server sidecar e2e scripts hooks pinokio shared; do
              echo "$k=true" >> "$GITHUB_OUTPUT"
              echo "scope $k=true (workflow_dispatch → full run)"
            done
            exit 0
          fi
          BASE="${{ github.event.pull_request.base.sha }}"
          HEAD="${{ github.event.pull_request.head.sha }}"
          FILES="$(git diff --name-only "$BASE" "$HEAD")"
          echo "Changed files in this PR:"
          echo "$FILES"
          echo "---"
          match() { echo "$FILES" | grep -qE "$1"; }
          frontend=false; server=false; sidecar=false
          e2e=false; scripts=false; hooks=false; pinokio=false; shared=false
          match '^(src/|index\.html$|vite\.config\.ts$|tailwind\.config\.ts$|tsconfig\.json$|tsconfig\.node\.json$|postcss\.config\.js$|eslint\.config\.(js|mjs)$)' && frontend=true
          match '^(server/src/|server/package(-lock)?\.json$|server/tsconfig\.json$|server/vitest\.config(\.slow)?\.ts$|openapi\.yaml$|server/\.env\.example$|server/scripts/sync-env-example\.ts$)' && server=true
          match '^server/tts-sidecar/' && sidecar=true
          match '^(e2e/|playwright\.config\.ts$)' && e2e=true
          match '^scripts/' && scripts=true
          match '^(\.husky/|scripts/run-hooks-tests\.mjs$|scripts/validate-commit-msg\.mjs$)' && hooks=true
          match '^(pinokio/|scripts/run-pinokio-tests\.mjs$)' && pinokio=true
          # `shared` = a ROOT dependency manifest changed → treat as global
          # (a dep/lockfile bump can affect every leg), so run everything.
          match '^(package\.json|package-lock\.json)$' && shared=true
          for k in frontend server sidecar e2e scripts hooks pinokio shared; do
            echo "$k=${!k}" >> "$GITHUB_OUTPUT"
            echo "scope $k=${!k}"
          done
```

- [ ] **Step 4: Add the "Config check" step**

Find the `Typecheck` step:

```yaml
      - name: Typecheck
        if: steps.changes.outputs.frontend == 'true' || steps.changes.outputs.server == 'true' || steps.changes.outputs.shared == 'true'
        run: npm run typecheck

      - name: Hooks tests
```

Insert a new step between them:

```yaml
      - name: Typecheck
        if: steps.changes.outputs.frontend == 'true' || steps.changes.outputs.server == 'true' || steps.changes.outputs.shared == 'true'
        run: npm run typecheck

      # Drift guard: fails if server/.env.example is out of sync with the
      # config registry. Previously ONLY ran via local `npm run verify` — see
      # docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md §3.
      - name: Config check
        if: steps.changes.outputs.server == 'true' || steps.changes.outputs.shared == 'true'
        run: npm run config:check

      - name: Hooks tests
```

- [ ] **Step 5: Add the "Pinokio tests" step**

Find the `PowerShell-helper tests (Pester)` step:

```yaml
      - name: PowerShell-helper tests (Pester)
        # No-ops with a banner on a runner without Pester 5 (the GitHub
        # ubuntu image ships pwsh but not Pester 5), exactly as the old
        # `npm run verify` leg did. Kept gated on `scripts` so it provides
        # real coverage if/when Pester 5 is bootstrapped on the runner.
        if: steps.changes.outputs.scripts == 'true'
        run: npm run test:scripts

      # `--changed <base>` narrows the frontend vitest run to only the tests
```

Insert a new step between them:

```yaml
      - name: PowerShell-helper tests (Pester)
        # No-ops with a banner on a runner without Pester 5 (the GitHub
        # ubuntu image ships pwsh but not Pester 5), exactly as the old
        # `npm run verify` leg did. Kept gated on `scripts` so it provides
        # real coverage if/when Pester 5 is bootstrapped on the runner.
        if: steps.changes.outputs.scripts == 'true'
        run: npm run test:scripts

      # Previously ONLY ran via local `npm run verify` — see
      # docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md §3.
      - name: Pinokio tests
        if: steps.changes.outputs.pinokio == 'true' || steps.changes.outputs.shared == 'true'
        run: npm run test:pinokio

      # `--changed <base>` narrows the frontend vitest run to only the tests
```

- [ ] **Step 6: Validate the YAML**

Run: `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/verify.yml', 'utf8'))"` if the `yaml` package is available, otherwise: `npx -y js-yaml .github/workflows/verify.yml > /dev/null && echo YAML_OK`
Expected: `YAML_OK` printed, no parse errors. (If neither tool is available,
visually re-read the full file for indentation consistency instead — every
`- name:` step must be indented exactly 6 spaces under `steps:`, matching
the surrounding unchanged steps.)

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/verify.yml
git commit -m "ci: flip verify.yml from opt-in to opt-out, add config-check + pinokio legs"
```

---

### Task 4: `.github/workflows/cross-os.yml` — twice-weekly cron

**Files:**
- Modify: `.github/workflows/cross-os.yml`

- [ ] **Step 1: Replace the schedule block**

Find:

```yaml
on:
  workflow_dispatch:
  schedule:
    # Sunday 02:00 UTC — well clear of weekday PR contention. Weekly pulse so
    # cross-OS / mobile regressions on main surface within a week even when
    # nobody fires the manual button.
    - cron: '0 2 * * 0'
```

Replace with:

```yaml
on:
  workflow_dispatch:
  schedule:
    # Twice weekly (was once) — see docs/superpowers/specs/2026-07-06-verify-
    # ci-rebalance-design.md §5: once local pre-push stops running a full
    # Windows/Pester/macOS-equivalent pass on every push, this cron becomes
    # the only regular cross-platform coverage, so the cadence doubles.
    - cron: '0 2 * * 3' # Wednesday 02:00 UTC
    - cron: '0 2 * * 0' # Sunday 02:00 UTC — well clear of weekday PR contention
```

- [ ] **Step 2: Validate the YAML**

Run the same validation approach as Task 3 Step 6, pointed at
`.github/workflows/cross-os.yml`.
Expected: no parse errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cross-os.yml
git commit -m "ci: bump cross-os.yml cron from weekly to twice-weekly (Wed+Sun)"
```

---

### Task 5: `CLAUDE.md` updates

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Commands list (new `verify:fast:branch` line)**

Find:

```
- `npm run verify` — full battery: typecheck + all tests + e2e + build (matches the pre-push hook).
- `npm run verify:quick` — all tests (no e2e, no typecheck, no build) — alias for `test:all`.
- `npm run verify:fast` — fast tests only (alias for `test:fast`) — pre-commit gate.
```

Replace with:

```
- `npm run verify` — full battery: typecheck + all tests + e2e + build. No longer the pre-push default (see "Commit gate") — run manually when you want the full local battery (e.g. before a release cut).
- `npm run verify:quick` — all tests (no e2e, no typecheck, no build) — alias for `test:all`.
- `npm run verify:fast` — fast tests only (alias for `test:fast`) — pre-commit gate.
- `npm run verify:fast:branch` — lint + typecheck + config:check + test:hooks + test + test:server + build, each scope-gated to whether the current branch's diff (vs local `main`) touches its inputs, plus `test:sidecar` scope-gated to `server/tts-sidecar/**`. This is the new pre-push default (see "Commit gate") — the fast, branch-scoped smoke check; cloud `verify.yml` is now the actual enforcement gate for everything else.
```

- [ ] **Step 2: Rewrite the pre-push bullet in "Commit gate"**

Find:

```
- **pre-push** (`.husky/pre-push`): first runs `scripts/guard-protected-push.mjs`,
  which refuses a force-push or deletion of a protected branch (`main`) before
  the battery even starts (a local guard; since 2026-06-14 `main` ALSO has
  server-side branch protection — a GitHub ruleset blocking force-push +
  deletion, enabled after the Pro upgrade per `com-4` — so this hook is now
  belt-and-suspenders; see
  [docs/features/163-protected-push-guard.md](docs/features/163-protected-push-guard.md);
  bypass the local hook intentionally with `git push --no-verify`). Then, unless
  the push is docs-only (below), runs `npm run verify` — typecheck + all tests
  + e2e + build. Refuses the push if any step fails.
```

Replace with:

```
- **pre-push** (`.husky/pre-push`): first runs `scripts/guard-protected-push.mjs`,
  which refuses a force-push or deletion of a protected branch (`main`) before
  the battery even starts (a local guard; since 2026-06-14 `main` ALSO has
  server-side branch protection — a GitHub ruleset blocking force-push +
  deletion, enabled after the Pro upgrade per `com-4` — so this hook is now
  belt-and-suspenders; see
  [docs/features/163-protected-push-guard.md](docs/features/163-protected-push-guard.md);
  bypass the local hook intentionally with `git push --no-verify`). Then, unless
  the push is docs-only (below), runs `npm run verify:fast:branch` — a fast,
  branch-diff-scoped subset (lint, typecheck, config:check, test:hooks, test,
  test:server, build, plus test:sidecar when the diff touches
  `server/tts-sidecar/**`). Refuses the push if any in-scope step fails. This
  replaced running the full `npm run verify` battery on every push (see
  [docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md))
  — the heavy legs (e2e, server-slow, scripts, test:pinokio) now run in the
  cloud instead, which is now the required, enforcing gate (see below).
```

- [ ] **Step 3: Rewrite the docs-only-pushes paragraph**

Find:

```
**Docs-only pushes skip `npm run verify` entirely** — `scripts/is-docs-only-push.mjs`
checks the pushed commits' changed-file set against the same doc-glob test as
CONTRIBUTING.md's "Doc-only PR fast-path" (`docs/**`, root `*.md`, `.github/*.md`);
a doc-only diff has no runtime surface for tests/build/e2e to exercise, so
paying the ~15-min battery locally is wasted time/CPU on top of the CI-side
skip. Conservative by design: any uncertainty (git error, unresolvable
merge-base) runs the full battery rather than guessing.
```

Replace with:

```
**Docs-only pushes skip `npm run verify:fast:branch` entirely** — `scripts/is-docs-only-push.mjs`
checks the pushed commits' changed-file set against the same doc-glob test as
CONTRIBUTING.md's "Doc-only PR fast-path" (`docs/**`, root `*.md`, `.github/*.md`);
a doc-only diff has no runtime surface for tests/build to exercise, so paying
even the fast local check is wasted time/CPU. Conservative by design: any
uncertainty (git error, unresolvable merge-base) runs the full selected-steps
battery rather than guessing.
```

- [ ] **Step 4: Rewrite the "GitHub CI is OPT-IN" paragraph**

Find the entire block from `**GitHub CI is OPT-IN (plan 215)**:` through the
`[archive/101]` reference line just before `Branching model and the full
commit convention...`:

```
**GitHub CI is OPT-IN (plan 215)**: the `verify.yml` battery does **not** run
automatically on PRs. The local pre-push hook already runs the FULL `npm run
verify` battery on every push, so a per-PR cloud run is redundant spend on
Actions minutes. Push freely — every PR push bills **0 CI minutes** by default.
Run the cloud battery on demand when you want a clean-room check: add the
**`run-ci`** label to the PR (fires one run; re-runs on each new push while the
label is on), or dispatch it manually (Actions tab → Verify → Run workflow, or
`gh workflow run verify.yml --ref <branch>`). A manual dispatch runs the full
battery; a labeled PR runs only the **scope-filtered** legs the diff touched
(plan 103 — `git diff` against the PR base; a frontend-only PR skips server
tests, a server-only PR skips Playwright e2e + the frontend unit suite, a root
`package.json`/`package-lock.json` change runs every leg).

What still runs automatically: `pr-title-lint.yml` and `pr-issue-link.yml` on
every PR, `app.yml` on `apps/android/**` changes (the only automated coverage
for the Flutter companion — no local hook runs `flutter analyze`/`test`),
`release.yml` on a `vX.Y.Z` tag, and `cross-os.yml` on its weekly Sunday cron. **Every release tag
now runs COMPLETE cross-platform verification before it publishes** (plan 215):
`release.yml` gates publish on full `npm run verify` (Ubuntu) + `test:e2e:mobile`
(Ubuntu) + `verify:quick`+build on macOS **and** Windows — a red leg on any
deployer OS blocks the public-beta release, so you no longer fire cross-OS by
hand before a release. `cross-os.yml` (`workflow_dispatch` + weekly cron on
`main`) stays as the between-releases pulse + ad-hoc cross-OS/mobile run. The
doc-only `paths-ignore` fast-path (plan 101) is a second layer — a `run-ci`-labeled
PR whose files are all docs still won't spin up the battery.
See [docs/features/215-ci-label-gated-verify.md](docs/features/215-ci-label-gated-verify.md),
[103](docs/features/103-ci-cost-reduction.md), and
[archive/101](docs/features/archive/101-docs-only-ci-skip.md).
```

Replace with:

```
**GitHub CI is OPT-OUT (2026-07-06, superseding plan 215's opt-in design)**:
the `verify.yml` battery runs automatically on every PR by default and is a
**required status check** on `main` — it actually blocks merge on red. This
replaces the prior opt-in/label-gated design, which existed to control
Actions-minute cost while the repo was private; the repo is now public, so
standard-runner Actions minutes are free and uncapped, and that rationale no
longer applies. Local pre-push now only runs a fast, branch-scoped subset
(`verify:fast:branch`) — this cloud run is the real enforcement gate for
everything else, not redundant insurance. Every leg is still
**scope-filtered** to what the PR's diff actually touched (plan 103 — `git
diff` against the PR base; a frontend-only PR skips server tests, a
server-only PR skips Playwright e2e + the frontend unit suite, a root
`package.json`/`package-lock.json` change runs every leg) — that scoping is
now about not running tests that can't fail, not about saving money. A
manual dispatch (Actions tab → Verify → Run workflow, or `gh workflow run
verify.yml --ref <branch>`) still runs the full unscoped battery, useful for
a clean-room check off a non-PR ref.

What still runs automatically: `pr-title-lint.yml` and `pr-issue-link.yml` on
every PR, `app.yml` on `apps/android/**` changes (the only automated coverage
for the Flutter companion — no local hook runs `flutter analyze`/`test`),
`release.yml` on a `vX.Y.Z` tag, and `cross-os.yml` on its **twice-weekly**
(Wednesday + Sunday) cron. **Every release tag now runs COMPLETE
cross-platform verification before it publishes** (plan 215): `release.yml`
gates publish on full `npm run verify` (Ubuntu) + `test:e2e:mobile` (Ubuntu)
+ `verify:quick`+build on macOS **and** Windows — a red leg on any deployer
OS blocks the public-beta release, so you no longer fire cross-OS by hand
before a release. `cross-os.yml` (`workflow_dispatch` + twice-weekly cron on
`main`) stays as the between-releases pulse + ad-hoc cross-OS/mobile run.
Docs-only PRs still complete `verify.yml` in seconds rather than deadlocking
the required check — every leg's own scope condition is false for a
docs-only diff, so the job just does env setup and reports green (see
[docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)
for why `paths-ignore` was deliberately removed rather than kept).
See [docs/features/215-ci-label-gated-verify.md](docs/features/215-ci-label-gated-verify.md)
and [103](docs/features/103-ci-cost-reduction.md) for the superseded opt-in
design's history/rationale, and
[docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)
for the current design.
```

- [ ] **Step 5: Rewrite the "Requesting a CI run on a PR" paragraph**

Find:

```
**Requesting a CI run on a PR (plan 215).** CI is opt-in (see "Commit gate"
above): push freely — drafts and ready PRs alike bill **0 Actions minutes**.
The local pre-push hook is the real gate and runs the full `npm run verify`
battery on every push. When you want a clean-room cloud check (typically right
before merge, or to confirm something you couldn't verify locally), add the
**`run-ci`** label to the PR or dispatch `verify.yml` manually — the labeled
run is insurance, not the gate. (Draft status no longer affects CI cost, so the
old draft-by-default dance is unnecessary; still open as draft if you simply
want to signal work-in-progress.) Rationale + measurements:
[docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md)
and [215](docs/features/215-ci-label-gated-verify.md).
```

Replace with:

```
**Requesting a clean-room CI run on a PR.** CI now runs automatically on
every PR push (see "Commit gate" above) and is the real, required gate —
you don't need to request it. Dispatch `verify.yml` manually (Actions tab →
Verify → Run workflow, or `gh workflow run verify.yml --ref <branch>`) only
when you want an unscoped, full-battery run off a non-PR ref. Rationale +
history of the prior opt-in design:
[docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md)
and [215](docs/features/215-ci-label-gated-verify.md); current design:
[docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md).
```

- [ ] **Step 6: Rewrite the "Working practice" first bullet**

Find:

```
Working practice:

- Before committing anything non-trivial, run `npm run verify` — same battery
  as pre-push. Catching failures in the same turn beats catching them at
  push time.
- `npm run verify:fast` matches pre-commit; `npm run verify:quick` is `test:all` without typecheck/build/e2e.
```

Replace with:

```
Working practice:

- Default loop for non-trivial work: finalize the change → run
  `npm run verify:fast:branch` (same branch-scoped check pre-push now runs)
  → open the PR → cloud `verify.yml` (required, opt-out) and the mandatory
  code-review pass run independently → merge once both are green. Run the
  full `npm run verify` manually only when you specifically want the full
  local battery (e.g. before a release cut, or debugging something scope-
  filtering might be hiding).
- `npm run verify:fast` matches pre-commit; `npm run verify:quick` is `test:all` without typecheck/build/e2e.
```

- [ ] **Step 7: Fix two more stale "pre-push gate" references**

Find (in the "Harnesses" test-tier list):

```
- Top-level `npm run test:all` runs the four unit/integration harnesses.
  `npm run verify` adds typecheck + e2e + build on top (pre-push gate).
```

Replace with:

```
- Top-level `npm run test:all` runs the four unit/integration harnesses.
  `npm run verify` adds typecheck + e2e + build on top (no longer the
  pre-push default — see "Commit gate" — but still the full local battery
  when you want to run it).
```

Find (in the "Before-shipping checklist", item 6):

```
6. **Run `npm run verify`** locally — same battery as pre-push. Catches typecheck + all tests + e2e + build in one shot.
```

Replace with:

```
6. **Run `npm run verify:fast:branch`** locally (same battery as pre-push) — or the full `npm run verify` if you want more than the branch-scoped subset. Cloud `verify.yml` is the required, authoritative gate either way (see "Commit gate").
```

- [ ] **Step 8: Validate every internal link still resolves**

Run: `grep -c "verify-ci-rebalance-design.md" CLAUDE.md`
Expected: `4` or more (confirms the new spec is now cross-linked from
CLAUDE.md at least 4 places per the edits above — pre-push bullet, OPT-OUT
paragraph ×2, Requesting-a-CI-run paragraph).

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(docs): update CLAUDE.md for opt-out required CI + branch-scoped pre-push"
```

---

### Task 6: `CONTRIBUTING.md` updates

**Files:**
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Rewrite the "Requesting a CI run" section**

Find the entire section from `### Requesting a CI run (CI is opt-in)` through
the `[docs/features/118-ci-cost-round-2.md]` reference line just before
`### Merge policy`:

```
### Requesting a CI run (CI is opt-in)

The `verify.yml` battery does **not** run automatically on PRs (plan 215). The
pre-push husky hook already runs the full `npm run verify` battery on every
push, so a per-PR cloud run is redundant spend on Actions minutes. Push freely
— every PR push (draft or ready) bills **0 CI minutes** by default. When you
want a clean-room cloud check (typically right before merge, or to sanity-check
a change you couldn't fully verify locally):

- add the **`run-ci`** label to the PR — fires one run, and re-runs on each new
  push while the label stays on; **or**
- dispatch it manually: Actions tab → Verify → Run workflow, or
  `gh workflow run verify.yml --ref <branch>`.

A labeled PR run is scope-filtered to the legs the diff touched (plan 103); a
manual dispatch runs the full battery. What still runs automatically on its own:
`pr-title-lint.yml` on every PR, `app.yml` on `apps/android/**` changes,
`release.yml` on a `vX.Y.Z` tag, and `cross-os.yml` (macOS + Windows + mobile
e2e) on its weekly cron + manual dispatch. **Every release tag runs the complete
cross-platform battery before publishing** (full `npm run verify` + mobile e2e on
Ubuntu, plus `verify:quick`+build on macOS and Windows — see `release.yml`), so
cross-OS coverage for a release is automatic, not a manual pre-announce step.
Rationale + measurements:
[docs/features/215-ci-label-gated-verify.md](docs/features/215-ci-label-gated-verify.md),
[docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md).
```

Replace with:

```
### Requesting a CI run (CI is opt-out and required)

The `verify.yml` battery runs automatically on every PR push and is a
**required status check** on `main` — it must go green before merge. This
replaced the prior label-gated opt-in design (plan 215) now that the repo is
public and standard-runner Actions minutes are free/uncapped; local pre-push
now only runs a fast, branch-scoped subset (`verify:fast:branch`), so the
cloud run is the actual enforcement gate, not optional insurance. Dispatch
it manually (Actions tab → Verify → Run workflow, or `gh workflow run
verify.yml --ref <branch>`) only when you want an unscoped, full-battery run
off a non-PR ref.

Every PR run is still scope-filtered to the legs the diff touched (plan
103); a manual dispatch runs the full battery. What still runs automatically
on its own: `pr-title-lint.yml` on every PR, `app.yml` on `apps/android/**`
changes, `release.yml` on a `vX.Y.Z` tag, and `cross-os.yml` (macOS +
Windows + mobile e2e) on its **twice-weekly** (Wednesday + Sunday) cron +
manual dispatch. **Every release tag runs the complete cross-platform
battery before publishing** (full `npm run verify` + mobile e2e on Ubuntu,
plus `verify:quick`+build on macOS and Windows — see `release.yml`), so
cross-OS coverage for a release is automatic, not a manual pre-announce
step. Rationale + history of the prior opt-in design:
[docs/features/215-ci-label-gated-verify.md](docs/features/215-ci-label-gated-verify.md),
[docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md);
current design:
[docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md).
```

- [ ] **Step 2: Update the cross-reference near "add the `run-ci` label"**

Find (near line 128-133, in an earlier section referencing the CI-run
section):

```
and only then (if you want a cloud check) add the **`run-ci`** label to the
```

Read the surrounding paragraph (a few lines before/after this fragment) to
capture full context, then rewrite that sentence to remove the now-inaccurate
"add the run-ci label" instruction — replace it with a sentence noting CI now
runs automatically on every PR push, linking to
`[§ Requesting a CI run](#requesting-a-ci-run-ci-is-opt-out-and-required)`
(the anchor changes because the heading text changed in Step 1 — GitHub
slugifies headings, so `### Requesting a CI run (CI is opt-out and
required)` becomes `#requesting-a-ci-run-ci-is-opt-out-and-required`).

- [ ] **Step 3: Update the "Server-side enforcement (branch protection)" paragraph**

Find:

```
`main` has **server-side branch protection** as of 2026-06-14: a GitHub ruleset
(`id 17654264`, `enforcement: active`) blocks force-push + deletion, enabled
after the **GitHub Pro** upgrade (the feature 403'd on the old Free private
plan). It **deliberately excludes required status checks** — so it stays
compatible with opt-in CI (plan 215) and the doc-only `paths-ignore` skip
without deadlocking PRs that never run `verify` — and adds no required-PR rule,
so direct-to-`main` trivial fixes and tag-based releases keep working. The local
`guard-protected-push.mjs` pre-push hook (plan 163) is now belt-and-suspenders.
Enablement + the ruleset JSON live in `com-4` / `brand/ruleset-main.json`. The
conventions above remain soft enforcement plus the `pr-title-lint.yml` workflow.
```

Replace with:

```
`main` has **server-side branch protection** as of 2026-06-14: a GitHub ruleset
(`id 17654264`, `enforcement: active`) blocks force-push + deletion, enabled
after the **GitHub Pro** upgrade (the feature 403'd on the old Free private
plan). As of the verify/CI rebalance
([docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md))
the ruleset also **requires** the `npm run verify` status check (`verify.yml`'s
job name) — this is safe against the doc-only-PR deadlock risk the prior
design avoided by excluding required checks entirely, because `verify.yml` no
longer has a `paths-ignore` that could prevent it from ever posting a status
(see that spec for why). It still adds no required-PR-review rule, so
direct-to-`main` trivial fixes and tag-based releases keep working. The local
`guard-protected-push.mjs` pre-push hook (plan 163) is now belt-and-suspenders.
Enablement + the ruleset JSON live in `com-4` / `brand/ruleset-main.json`. The
conventions above remain soft enforcement plus the `pr-title-lint.yml` workflow.
```

- [ ] **Step 4: Update the "Doc-only PR fast-path" section**

Find:

```
### Doc-only PR fast-path

A PR whose changed-file set lives entirely under `docs/**`, root-level
`*.md` (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`), or
`.github/*.md` (e.g. `.github/pull_request_template.md`) skips
[`verify.yml`](.github/workflows/verify.yml) via `paths-ignore`.
The PR still requires a valid title (`pr-title-lint.yml` runs on every
PR) and GitHub's native `mergeable` status still surfaces conflicts —
the gate stays "PR required + title valid + no conflicts", just without
the 10–15 min full battery. Since plan 215 CI is opt-in for _every_ PR, this
`paths-ignore` is now a second layer — it additionally ensures that even a
`run-ci`-labeled PR whose files are all docs won't spin up the battery.
Rationale and the exact glob list:
[docs/features/archive/101-docs-only-ci-skip.md](docs/features/archive/101-docs-only-ci-skip.md).

The same file-set test also skips the **local** pre-push `npm run verify`
battery (`scripts/is-docs-only-push.mjs`, wired into `.husky/pre-push`) — a
```

Replace with:

```
### Doc-only PR fast-path

A PR whose changed-file set lives entirely under `docs/**`, root-level
`*.md` (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`), or
`.github/*.md` (e.g. `.github/pull_request_template.md`) still triggers
[`verify.yml`](.github/workflows/verify.yml) (its `paths-ignore` was
deliberately removed — see
[docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)
for why: keeping it while the check is required would deadlock every
docs-only PR forever). Every leg's own scope condition evaluates false for
a docs-only diff, though, so the job completes in roughly the time of "Setup
Node + deps" alone (~20-40s) and reports green — the gate stays "PR required
+ title valid + no conflicts + a fast green required check", not the 10-15
min full battery. Rationale and the exact glob list for the underlying
scope-matching (unrelated to the removed `paths-ignore`):
[docs/features/archive/101-docs-only-ci-skip.md](docs/features/archive/101-docs-only-ci-skip.md).

The same file-set test also skips the **local** pre-push
`npm run verify:fast:branch` check (`scripts/is-docs-only-push.mjs`, wired
into `.husky/pre-push`) — a
```

- [ ] **Step 5: Fix five more stale "pre-push gate" / "npm run verify" references**

Find (in the `## TL;DR` list):

```
- `main` is always shippable. `npm run verify` is the pre-push gate.
```

Replace with:

```
- `main` is always shippable. `npm run verify:fast:branch` is the pre-push gate; cloud `verify.yml` is the required, authoritative gate.
```

Find (in "PR body", the `## Test plan` bullet):

```
2. **`## Test plan`** — checklist of what was run and what reviewers should
   look at. Always start with `- [ ] npm run verify — green` (the pre-push
   hook will fail your push if it isn't anyway).
```

Replace with:

```
2. **`## Test plan`** — checklist of what was run and what reviewers should
   look at. Always start with `- [ ] npm run verify:fast:branch — green`
   (the pre-push hook will fail your push if it isn't anyway) — cloud
   `verify.yml` is the required, authoritative gate on top of that.
```

Find (in "Before requesting review"):

```
- `npm run verify` green locally (pre-push hook already enforces this).
```

Replace with:

```
- `npm run verify:fast:branch` green locally (pre-push hook already enforces this) — and the required cloud `verify.yml` check green on the PR.
```

Find (in the numbered pre-shipping checklist near the end of the file):

```
5. Run `npm run verify` locally.
```

Replace with:

```
5. Run `npm run verify:fast:branch` locally (pre-push already enforces it) — the required cloud `verify.yml` check covers the rest.
```

- [ ] **Step 6: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs(docs): update CONTRIBUTING.md for opt-out required CI"
```

---

### Task 7: `docs/features/118`, `215`, `235` — superseded/cross-reference notes

**Files:**
- Modify: `docs/features/118-ci-cost-round-2.md`
- Modify: `docs/features/215-ci-label-gated-verify.md`
- Modify: `docs/features/235-model-routing-review-gates.md`

- [ ] **Step 1: Add a superseded note to doc 118**

Find (the frontmatter + header block):

```
---
status: active
shipped: null
owner: null
---

# CI cost reduction — round 2 (run-count + test-impact selection)

> Status: active
> Key files: `.github/workflows/verify.yml`, `.github/workflows/pr-title-lint.yml`, `.github/workflows/release.yml`, `vitest.config.ts`, `CLAUDE.md`, `CONTRIBUTING.md`
> URL surface: none (CI / process)
> OpenAPI ops: none

## Benefit / Rationale
```

Replace with:

```
---
status: active
shipped: null
owner: null
---

# CI cost reduction — round 2 (run-count + test-impact selection)

> Status: active
> Key files: `.github/workflows/verify.yml`, `.github/workflows/pr-title-lint.yml`, `.github/workflows/release.yml`, `vitest.config.ts`, `CLAUDE.md`, `CONTRIBUTING.md`
> URL surface: none (CI / process)
> OpenAPI ops: none

> **Update 2026-07-06:** the cost-minimization *posture* this doc describes
> (opt-in CI, draft-PR batching to avoid billed runs) is superseded by
> [docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](../superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)
> now that the repo is public — Actions minutes on standard runners are free
> and uncapped, so CI flips from opt-in to opt-out and required. This doc's
> test-impact-selection mechanism (`--changed <base>`) and its cost analysis
> remain accurate history/rationale for why that mechanism exists; only the
> "minimize run count" framing is stale.

## Benefit / Rationale
```

- [ ] **Step 2: Add a superseded note to doc 215**

Find:

```
---
status: active
shipped: null
owner: null
---

# CI is opt-in — label-gated / dispatch-only verify

> Status: active
> Key files: `.github/workflows/verify.yml`, `CLAUDE.md`, `CONTRIBUTING.md`
> URL surface: none (CI / process)
> OpenAPI ops: none

## Benefit / Rationale
```

Replace with:

```
---
status: active
shipped: null
owner: null
---

# CI is opt-in — label-gated / dispatch-only verify

> Status: active
> Key files: `.github/workflows/verify.yml`, `CLAUDE.md`, `CONTRIBUTING.md`
> URL surface: none (CI / process)
> OpenAPI ops: none

> **Update 2026-07-06:** superseded by
> [docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](../superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)
> — the opt-in/label-gated design this doc describes flips to opt-out (CI
> runs on every PR by default) and the check becomes required on `main`'s
> ruleset, now that the repo is public and Actions minutes are free/uncapped
> (the reason this doc's opt-in design existed no longer applies). This
> doc's per-run cost-reduction mechanisms (scope-gated legs, one-job design)
> remain in effect and accurate.

## Benefit / Rationale
```

- [ ] **Step 3: Note the shared ruleset action in doc 235**

Find (in the "Invariants to preserve" list):

```
3. `.github/workflows/pr-issue-link.yml`'s job `name:` field ("Verify PR body links a GitHub issue") is the exact string referenced by the required-status-check ruleset (Task 7 Step 8, the manual step) — renaming the job without updating the ruleset silently breaks the required-check binding.
```

Replace with:

```
3. `.github/workflows/pr-issue-link.yml`'s job `name:` field ("Verify PR body links a GitHub issue") is the exact string referenced by the required-status-check ruleset (Task 7 Step 8, the manual step) — renaming the job without updating the ruleset silently breaks the required-check binding.
4. That same manual ruleset step now also needs to bind `verify.yml`'s `npm run verify` job name (see [docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md](../superpowers/specs/2026-07-06-verify-ci-rebalance-design.md)) — do both required-check bindings in the same GitHub settings visit if convenient, but they're independent action items; this doc's Task 7 Step 8 landing does not depend on the other one landing, or vice versa.
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/118-ci-cost-round-2.md docs/features/215-ci-label-gated-verify.md docs/features/235-model-routing-review-gates.md
git commit -m "docs(docs): cross-reference the verify/CI rebalance spec from docs 118, 215, 235"
```

---

### Task 8: Configure the required-status-check ruleset (MANUAL — orchestrator + user, not a subagent)

**This task is NOT dispatched to a subagent.** It changes `main`'s branch
protection — a shared, hard-to-reverse GitHub setting — so it must be done
by the orchestrating session with the user present to confirm, exactly like
the still-pending equivalent action for `pr-issue-link.yml` (doc 235, Task 7
Step 8) has been treated. Do this only after Tasks 1-7 are merged to `main`
(the ruleset should reference a check that's already running there).

- [ ] **Step 1: Confirm current ruleset state**

Run: `gh api repos/dudarenok-maker/Castwright/rulesets` and identify the
ruleset covering `main` (per CONTRIBUTING.md, `id 17654264`). Read its
current `rules` array to confirm it has no `required_status_checks` rule
yet (matches the documented "deliberately excludes required checks" state).

- [ ] **Step 2: Present the exact change to the user and get explicit go-ahead**

State plainly: this will add a `required_status_checks` rule to ruleset
`17654264` requiring the `npm run verify` check (the `verify.yml` job name)
to pass before merge on `main`. Ask the user to confirm before proceeding —
do not run Step 3 without an explicit yes in this session.

- [ ] **Step 3: Apply the ruleset change**

Once confirmed, use `gh api` (PATCH or PUT against
`repos/dudarenok-maker/Castwright/rulesets/17654264`) to add a
`required_status_checks` rule listing `npm run verify` as a required check
(add `Verify PR body links a GitHub issue` too in the same call if the user
wants doc 235's pending item bundled in — ask which they want per the plan's
Task 8 framing, don't assume).

- [ ] **Step 4: Verify**

Open a throwaway test PR (or use the PR this plan's work will ship through)
and confirm the `npm run verify` check now shows as required (GitHub's PR
merge-box UI shows "Required" next to it, and the merge button stays
disabled until it's green).

- [ ] **Step 5: Update doc 235 if bundled**

If Step 3 also bound `pr-issue-link.yml`'s check, update
`docs/features/235-model-routing-review-gates.md`'s "Reversibility" bullet
and Task 7 Step 8 references to say the ruleset step is now DONE, not
pending. (If only `verify.yml` was bound this round, leave doc 235's
pending-step language as-is — it's now handled by whichever task actually
lands it.)

---

## Self-Review Notes (from the writing-plans skill's required self-check)

**Spec coverage:** every numbered design section (§1-§6) of
`docs/superpowers/specs/2026-07-06-verify-ci-rebalance-design.md` maps to a
task above: §1 (new default loop) → Task 5 Step 6 (Working practice
rewrite); §2 (STEPS reclassification) → reflected in Task 1's step list and
Task 3's new legs; §3 (CI trigger) → Task 3 + Task 8; §4 (pre-push +
verify:fast:branch) → Tasks 1-2; §5 (cross-os cadence) → Task 4; §6 (what
stays the same) → deliberately NOT touched by any task (pre-commit,
commit-msg, code-review gate, `npm run verify` itself, `release.yml`,
`test:golden-audio`). "Docs to update" → Tasks 5-7. "Risks/follow-ups" → the
routine-server-push residual-contention risk and the local-`main`-staleness
risk are accepted as documented tradeoffs, not additional tasks (the spec
itself says they're open/accepted, not blockers).

**Placeholder scan:** no TBD/TODO; every code block above is complete,
copy-pasteable text, not a description of what to write.

**Type/name consistency:** `branchDiffFiles(cwd)` (Task 1) is the exact name
Task 1's own wiring step (Step 5) and test step (Step 1) both use — no
naming drift. `verify:fast:branch` (Task 1 Step 7) is the exact script name
Task 2 (pre-push), Task 5 (CLAUDE.md, 5 places), and Task 6 (CONTRIBUTING.md)
all reference — checked for literal string match across every task above.

**Completeness sweep:** ran `grep -n "npm run verify\b" CLAUDE.md
CONTRIBUTING.md` against the finished task list and reconciled every hit —
9 additional stale "pre-push gate"/"npm run verify" references beyond the
ones the spec called out directly were found this way and folded into Task
5 Step 7 and Task 6 Step 5. The remaining hits (cache-aware/lint-prepend
paragraphs, `release.yml`'s own full-battery description, the deliberate
full-`npm run verify` usage in parallel-agent integration-branch
reconciliation) describe behavior that's still accurate and were
deliberately left untouched — noted here so a reviewer doesn't have to
re-derive why they're not in the task list.
