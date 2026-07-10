# Library header book-count copy fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the hardcoded "book seven" from the library welcome subhead in `src/components/library/library-chrome.tsx` so the copy no longer contradicts the six-book series story shown elsewhere on the same screen (issue #1461), and land it on a PR.

**Architecture:** Single-line static JSX text edit. No component logic, props, or data flow changes — this is copy-only.

**Tech Stack:** React/TSX frontend (`src/components/library/library-chrome.tsx`), Playwright visual-regression baselines (`e2e/win32/responsive/visual.spec.ts`).

## Global Constraints

- Replacement copy must be number-agnostic (per spec's Fix section and issue #1461's suggested fix) — no swapping one hardcoded book count for another.
- `e2e/marketing/scenes.ts`'s `library-shelf` / `library-shelf-full` scenes are explicitly out of scope for this change — the user is regenerating those separately.
- Conventional Commits format is enforced by a commit-msg hook: `<type>(<scope>): <subject>`, allowed scopes include `frontend`, `docs`, `ci`, etc. (see `CONTRIBUTING.md`).

---

## Status: implementation already complete

All work this plan would otherwise task out has already been done and committed on this worktree's branch (`worktree-fix+library-header-book-count-1461`), in a single commit `9621ef89` — "fix(frontend): make library header subhead number-agnostic (#1461)". This plan documents what shipped in that commit and defines the one remaining step: finishing the branch.

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

- [ ] **Step 1: Confirm the working tree is clean and the commit is present**

Run: `git status --porcelain && git log --oneline -1`
Expected: no output from `git status --porcelain` (clean tree); `git log` shows `9621ef89 fix(frontend): make library header subhead number-agnostic (#1461)` as HEAD.

- [ ] **Step 2: Invoke the finishing-a-development-branch skill**

Use `superpowers:finishing-a-development-branch` to decide how to land this branch (PR creation, merge target, etc.) and open the PR for issue #1461. Reference the spec at `docs/superpowers/specs/2026-07-10-library-header-book-count-design.md` in the PR body, and note in the PR description that `e2e/marketing/scenes.ts` regeneration is being handled separately by the user.

---

## Self-Review

**Spec coverage:** Problem → documented (commit message + spec). Fix → applied verbatim in `library-chrome.tsx`. Scope (screenshot suites) → both `e2e/responsive/visual.spec.ts` (verified, one baseline regenerated) and `e2e/marketing/scenes.ts` (explicitly deferred) are accounted for. Testing → all listed checks ran and passed; no gaps found against the spec.

**Placeholder scan:** No TBD/TODO markers; all steps show exact commands and exact diffs already applied.

**Type consistency:** N/A — no new functions, types, or interfaces introduced; this is a copy-only change with a single downstream consumer (the rendered `<p>` element), already verified via the component test and visual baselines.
