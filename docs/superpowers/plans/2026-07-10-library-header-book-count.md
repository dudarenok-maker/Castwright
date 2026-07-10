# Library header book-count copy fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the hardcoded "book seven" from the library welcome subhead in `src/components/library/library-chrome.tsx` so the copy no longer contradicts the six-book series story shown elsewhere on the same screen (issue #1461), and land it on a PR.

**Architecture:** Single-line static JSX text edit. No component logic, props, or data flow changes — this is copy-only.

**Tech Stack:** React/TSX frontend (`src/components/library/library-chrome.tsx`), Playwright visual-regression baselines (`e2e/win32/responsive/visual.spec.ts`).

## Global Constraints

- Replacement copy must be number-agnostic (per spec's Fix section and issue #1461's suggested fix) — no swapping one hardcoded book count for another.
- `e2e/marketing/scenes.ts`'s `library-shelf` / `library-shelf-full` scenes are explicitly out of scope for this change — the user is regenerating those separately.
- Conventional Commits format is enforced by a commit-msg hook: `<type>(<scope>): <subject>`, allowed scopes include `frontend`, `docs`, `ci`, etc. (see `CONTRIBUTING.md`).
- Branches must be named `<type>/<scope>-<slug>` (`CONTRIBUTING.md:16`, e.g. `feat/server-batch-retry`) — `finishing-a-development-branch`'s Option 2 pushes `git push -u origin <feature-branch>` verbatim with no rename step, so the branch must already be conventionally named before that skill runs.

---

## Status: implementation already complete

All work this plan would otherwise task out has already been done and committed on branch `fix/frontend-library-header-book-count`. As of this writing, the commit history (oldest first) is:

1. `7e46f9ab` — `docs(docs): add design for library header book-count copy fix (#1461)`
2. `9621ef89` — `fix(frontend): make library header subhead number-agnostic (#1461)` — the actual code change; nothing after this point touches source.
3. `4050165e` — `docs(docs): add library header book-count implementation plan (#1461)`
4. `4ffcf6bd` — `docs(docs): address round-1 assumption-checker findings in the implementation plan`
5. (this round's fix commit, whatever it's hashed as once committed)

**This list is historical record, not a live check** — every doc-fix commit against this plan file adds another entry, so Task 1 Step 1 below deliberately does *not* pin exact hashes/positions (round 1 and round 2 of reviewing this very plan each caught the previous version's hash list going stale the moment the next fix was committed).

The branch was originally auto-created by `EnterWorktree` as `worktree-fix+library-header-book-count-1461` (its slash-mangling naming scheme), which violates the `<type>/<scope>-<slug>` convention above — it has since been renamed in place via `git branch -m fix/frontend-library-header-book-count` (safe to run from inside the worktree; renames the currently-checked-out branch, no re-checkout needed). This plan documents what shipped and defines the one remaining step: finishing the branch.

### What's in commit `9621ef89`

**File: `src/components/library/library-chrome.tsx`** (line ~100)

```diff
           <p className="mt-3 text-ink/60 max-w-xl">
             Pick up where you left off, or start a new book. Voices stay consistent across a series
-            — characters who appear in book one carry through to book seven.
+            — characters who appear in book one carry through, book after book.
           </p>
```

**File: `e2e/win32/responsive/visual.spec.ts/tablet-chrome/library.png`** (regenerated binary baseline)

At the `tablet-chrome` viewport, the paragraph still wraps to two lines but the new copy shifts pixel content slightly versus the old baseline — this file was regenerated via `--update-snapshots` and committed so the local Windows baseline stays accurate. (`chromium` and `mobile-chrome` baselines needed no change — verified zero diff.)

**File: `docs/superpowers/specs/2026-07-10-library-header-book-count-design.md`**

Finalized spec: problem statement, the fix, scope (including the two screenshot suites that capture this string), and a Testing section documenting exactly what was and wasn't verified and why (see below).

### Verification already performed (do not re-run as a blocking gate — recorded for the record)

- `npx tsc --noEmit -p .` — clean.
- `npx eslint src/components/library/library-chrome.tsx` — clean.
- `npx vitest run src/components/library/library-chrome.test.tsx` — 15/15 passed (no test asserts the changed string).
- Full frontend suite: `npm run test` (via pre-commit hook) — 280 files / 3731 tests passed.
- `npx playwright test --project=chromium --workers=1 e2e/responsive/visual.spec.ts -g library --update-snapshots` — zero baseline files touched (within `maxDiffPixelRatio: 0.05`).
- `npx playwright test --project=mobile-chrome --project=tablet-chrome --workers=1 e2e/responsive/visual.spec.ts -g library --update-snapshots` — `mobile-chrome` zero diff; `tablet-chrome` `library.png` (light theme) regenerated and committed, `library-dark.png` unaffected.
- Confirmed (via `e2e/responsive/visual.spec.ts:50-58` and `.github/workflows/verify.yml`'s `e2e-visual` job) that PR CI currently skips this whole visual suite on Linux (no `e2e/linux/...` baselines committed yet — separate in-flight initiative), so this change carries no CI-blocking visual risk either way.
- `e2e/marketing/scenes.ts`'s `library-shelf` / `library-shelf-full` scenes were deliberately left unregenerated — explicit user decision, out of scope for this change.

---

### Task 1: Finish the branch

**Files:** none (process step only)

**Interfaces:** N/A

- [ ] **Step 1: Confirm the working tree is clean, on the renamed branch, with the fix commit present**

Run: `git status --porcelain && git branch --show-current && git log --oneline --grep="make library header subhead number-agnostic"`
Expected: no output from `git status --porcelain` (clean tree); branch is `fix/frontend-library-header-book-count`; the grep finds exactly one match, `9621ef89 fix(frontend): make library header subhead number-agnostic (#1461)` (hash may differ if this plan is ever rebased/cherry-picked — match on message, not hash). Deliberately not checking an exact `git log -N` window or commit count: this plan file has already gone through two assumption-checker fix rounds, each adding its own `docs(docs):` commit, and pinning positional/count-based expectations broke on both previous rounds the moment the next fix landed.

- [ ] **Step 2: Invoke the finishing-a-development-branch skill**

Use `superpowers:finishing-a-development-branch` to decide how to land this branch (PR creation, merge target, etc.) and open the PR for issue #1461. Base branch is `main` (confirmed via `git merge-base HEAD origin/main` = `cf3ed9f7`, the branch's fork point). Reference the spec at `docs/superpowers/specs/2026-07-10-library-header-book-count-design.md` in the PR body, and note in the PR description that `e2e/marketing/scenes.ts` regeneration is being handled separately by the user.

**Expected choice: Option 2 (Push and Create PR).** This sidesteps a worktree-cleanup ambiguity: this session's worktree was created via the harness's `EnterWorktree` tool, which tracks it independently of git. `finishing-a-development-branch`'s Step 6 cleanup (only triggered by Options 1/4, never Option 2) decides "we own cleanup" for any worktree path containing `worktrees/` — true here (`.claude/worktrees/...`) — and calls `git worktree remove` directly, which the harness's own tracking wouldn't observe. If Option 1 or 4 is chosen instead of Option 2, use this session's `ExitWorktree` tool for cleanup rather than letting that skill's `git worktree remove` run directly, so the harness's worktree-session state doesn't desync from actual git state.

---

## Self-Review

**Spec coverage:** Problem → documented (commit message + spec). Fix → applied verbatim in `library-chrome.tsx`. Scope (screenshot suites) → both `e2e/responsive/visual.spec.ts` (verified, one baseline regenerated) and `e2e/marketing/scenes.ts` (explicitly deferred) are accounted for. Testing → all listed checks ran and passed; no gaps found against the spec.

**Placeholder scan:** No TBD/TODO markers; all steps show exact commands and exact diffs already applied.

**Type consistency:** N/A — no new functions, types, or interfaces introduced; this is a copy-only change with a single downstream consumer (the rendered `<p>` element), already verified via the component test and visual baselines.

**Round-1 assumption-checker findings folded in:** the plan originally described the branch as `worktree-fix+library-header-book-count-1461` (EnterWorktree's auto-generated name) and had Task 1 Step 1 check for a clean tree that the plan doc itself would have violated. Both fixed: branch renamed in place to `fix/frontend-library-header-book-count` (matches `CONTRIBUTING.md:16`'s `<type>/<scope>-<slug>`, confirmed `finishing-a-development-branch` never renames branches itself), and the plan doc is now committed (`4050165e`) before Task 1's clean-tree check runs.

**Round-2 assumption-checker findings folded in:** the round-1 fix commit (`4ffcf6bd`) immediately made Task 1 Step 1's positional `git log --oneline -3` check and Step 2's "3 commits ahead" claim stale again — confirmed via direct re-run (`git log --oneline -3` no longer matched; `git rev-list --count origin/main..HEAD` was 4, not 3). Fixed by making Step 1's check message-based (`git log --grep`) instead of positional, dropping the exact ahead-count claim, and reframing the Status section's commit list as an explicitly historical, non-live record. Also folded in: an explicit note that Option 2 (Push + PR) is the expected `finishing-a-development-branch` choice, and why — it avoids a worktree-cleanup ownership ambiguity between the harness's `EnterWorktree`/`ExitWorktree` tracking and that skill's own generic `git worktree remove` heuristic (only relevant if Option 1/4 were chosen instead).
