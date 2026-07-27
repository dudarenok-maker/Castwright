# Design — make `forceRerunTriggers` survive a dot-prefixed checkout (ops-33, #1868)

**Date:** 2026-07-27
**Issue:** [#1868](https://github.com/dudarenok-maker/Castwright/issues/1868) (ops-33)
**Branch:** `fix/ops-force-rerun-triggers` (worktree `C:\Claude\Projects\wt-force-rerun-triggers`, cut from `main` @ `7b0cc955`)
**Status:** draft — awaiting review

## Problem

`vitest run --changed <base>` narrows a run to tests whose module graph touches the diff. Files with no module-graph edge — the manifest, the test configs, `openapi.yaml`, the injected setup file — are covered instead by `forceRerunTriggers`: a changed file matching one of those globs forces a full run.

picomatch's `**` refuses to cross a **dot-prefixed path segment** unless `{ dot: true }` is passed. Vitest passes no options at either call site — `cli-api…js:11495` (`pm(forceRerunTriggers)`, the `--changed` path) and `:12916` (`pm.isMatch`, the watch path). Claude-Code-harness worktrees live under `.claude/worktrees/…`, so from one, **every** trigger silently matches nothing.

The failure mode is `0 tests found, exit 0` — it reads as success.

### Measured

`vitest list --changed HEAD` against a single-file dirty tree; vitest 4.1.9, picomatch 4.0.5, Windows.

First pass, taken against `main` @ `0bf1f411` (before #1873 added a test file, so the suite total was 322):

| checkout | dirty file | test files selected |
|---|---|---|
| `C:\Claude\Projects\wt-force-rerun-triggers` (non-dotted) | `package.json` | **322** |
| `…\.claude\worktrees\ops33-probe` (dotted) | `package.json` | **0** |
| dotted, with the dot-tolerant pattern applied | `package.json` | **322** |

Confirmed afterwards in a **single** dotted checkout with only the configs swapped between `main` @ `7b0cc955` and this branch — the cleaner comparison, since it varies one thing:

| config | `main` | this branch |
|---|---|---|
| `vitest.config.ts` | 1 | **323** |
| `server/vitest.config.ts` | 0 | **446** |
| `server/vitest.config.slow.ts` | 0 | **10** |

323 is the full frontend suite post-#1873 (`vitest list --filesOnly` → 323). The lone `1` on `main` is the new test file itself, selected via its real import edge to `vitest.config.ts`.

## Relationship to ops-30 / #1873

ops-30 (#1848) was a *different* defect in the same arrays — a wildcard-bearing segment followed by `/**` matches nothing anywhere. It was fixed and closed by PR #1873 (merged 2026-07-27), which pinned the extension to `.ts` and gave `server/vitest.config.slow.ts` its own explicit array. **That work is done and is not revisited here.**

#1873 is, however, the second recorded incident of ops-33 costing time. Its two new test files — `src/test/force-rerun-triggers.test.ts` and `server/src/force-rerun-triggers.test.ts` — both hit this bug and route around it with a synthetic `/repo/…` root, carrying the comment:

> picomatch's `**` refuses to cross a dot-prefixed path segment (its default `dot: false`) — this checkout happens to live under `.claude/worktrees/...`, so matching the file's REAL on-disk absolute path would spuriously fail here regardless of the trigger patterns.

The first incident was #1848 itself, where the confounder produced the same "No test files found" symptom as the bug under investigation and forced the measurement to be taken from a throwaway non-dotted checkout.

## Corrections to the issue's premises

Recorded because #1868 will be closed by this work and its text is otherwise the record.

1. **"Key files" lists three configs carrying `forceRerunTriggers`.** At filing time `server/vitest.config.slow.ts` carried none — it inherited vitest's defaults. #1873 has since given it an explicit array, so the issue's claim is now true by accident rather than by observation.
2. **The workaround is cheaper than the issue assumes.** #1868 calls an in-pattern fix "possible but ugly … would need to be repeated in all three configs". The measured form is a single brace alternative, and it is *generic* — it tolerates any dot segment rather than hard-coding `.claude`, so it does not encode the harness's directory layout.
3. **A Windows-specific failure mode was hypothesised and disproved.** `findChangedFiles` ends in `resolve(options.root, file)`, which on Windows appears to yield backslash paths that picomatch 4 (which, unlike v3, does *not* auto-detect Windows) would never match. It does not: vitest bundles `pathe`, so paths stay forward-slashed. The 322-file run at a Windows root is the proof. No platform-specific handling is needed in the configs — but see the test design below, where `path.resolve` *does* yield backslashes and must be normalised.

## Design

### 1. Pattern form

Every trigger becomes `{**/X,**/.*/**/X}`. The first alternative covers a clean root (Windows or posix, including the CI runner path); the second names a dot segment literally, which is the only thing that lets the leading `**` reach past it without `{ dot: true }`.

The trailing `/**` is dropped — the new form matches the target file directly.

| file | triggers today (post-#1873) | count |
|---|---|---|
| `vitest.config.ts` | `package.json`, `{vitest,vite}.config.ts`, `src/test/setup.ts`, `openapi.yaml` | 4 |
| `server/vitest.config.ts` | `package.json`, `{vitest,vite}.config.ts`, `openapi.yaml`, **`vitest.config.slow.ts`** (added, see Amendments #1) | 4 |
| `server/vitest.config.slow.ts` | `package.json`, `vitest.config.slow.ts` | 2 |

All 10 are rewritten. Nested braces (`{**/{vitest,vite}.config.ts,…}`) are verified during implementation before being committed.

### 2. Tests — extend, do not add

The two files #1873 created are the right home; this change removes their need to work around the bug.

`realFileAsAbsPath` currently returns one synthetic path. It becomes a set of **three root shapes**, each asserted per covered file:

| shape | example | why |
|---|---|---|
| synthetic clean | `/repo/package.json` | preserves #1873's existing intent — the CI/production shape |
| synthetic dotted | `/repo/.claude/worktrees/x/package.json` | **pins ops-33 regardless of where the suite runs.** Essential: in CI the real path is non-dotted, so a dot regression would otherwise pass CI unnoticed |
| real on-disk | `resolve(REPO_ROOT, rel)`, forward-slash normalised | proves the mechanism works *where this suite is actually executing* — passes from a dotted worktree only once the patterns are dot-tolerant |

The existing `existsSync` guard stays, so a covered file going missing still fails.

The synthetic-root comments in both files are rewritten: they currently describe the dot limitation as accepted, which stops being true.

### 3. Documentation

- CONTRIBUTING.md worktree section: one note that `--changed` was dot-sensitive, that this is now covered by the trigger patterns, and that `npm run wt-new` creates worktrees at `../wt-<slug>` (non-dotted) while harness `isolation: "worktree"` agents land under `.claude/worktrees/`.
- Config comments updated to name both failure modes rather than only ops-30's.

### 4. Release notes

`docs/release-notes-next.md` (technical register) only. No `RELEASE_NOTES.md` line — nothing a Castwright user sees changes. Stated explicitly in the PR body rather than silently omitted.

## Acceptance

- A `package.json`-only diff selects the full suite from a `.claude/worktrees/…` checkout (measured 0 → 322).
- The same diff still selects the full suite at a non-dotted root, and a config-only diff still does too (no ops-30 regression).
- Both server configs behave the same way, including `slow`.
- The extended tests fail if any trigger loses its dot-tolerant alternative.
- `npm run verify:fast:branch` green.

## Risks

- **Concurrent session.** PR #1873 touched these exact files and its cleanup deleted an earlier branch and worktree of this work mid-session. Mitigation: commit and push early so the branch survives another prune, and re-check `main` before opening the PR.

## Amendments after independent review

The Opus review pass on PR #1879 returned no HIGH/CRITICAL findings and confirmed the core fix and the tests' non-placebo status by mutation. Seven findings were folded in:

1. **`server/vitest.config.ts` gained a `vitest.config.slow.ts` trigger.** The `{vitest,vite}.config.ts` brace never matched `vitest.config.slow.ts`, and nothing else created an edge (`SLOW_FILES` has no importers; the guard test reaches both configs by runtime-computed dynamic import). So a slow-config-only diff selected **zero** tests from the suite that holds its own guard — the guard could have been reverted with CI green. Trigger count is therefore **10**, not 9.
2. **Both tests now cover `vite.config.ts`.** Narrowing the brace to `vitest.config.ts` previously left every assertion green while dropping coverage for the vite build config. Mutation-verified: 3 cases go red.
3. **The one-segment bound is now documented** in the config comment, CONTRIBUTING.md and the release notes. Two dot segments still miss — a known bound, and a loud one: the `this checkout` case goes red rather than under-selecting.
4. **Negative controls use real files** (`src/main.tsx`, `tsconfig.json`, `apps/android/pubspec.yaml`) with their own `existsSync` guards, replacing `src/App.tsx`, which does not exist in this repo. Three shapes instead of one, so a widening to a suffix glob is caught, not just a bare globstar.
5. **Measured numbers corrected** — see the two tables above; the original single figure conflated a pre-#1873 total with a post-#1873 one. picomatch is 4.0.5, not 4.0.4.
6. **"every trigger" softened to "every glob trigger".** Vitest appends resolved `setupFiles` as absolute paths, which carry no wildcard and cross dot segments fine, so one implicit trigger always worked. This does not affect the measured zero-selection result — a `package.json`-only diff never touches the setup file.
7. **`absPathUnder` derives nesting** via `relative(REPO_ROOT, base)` instead of comparing identity against `SERVER_ROOT`, which would have silently re-introduced the earlier finding-11 bug the moment a third base was added.

## Out of scope

- Reporting upstream to vitest (`{ dot: true }`). Listed as a "consider" on both issues; not a repo change and should not gate this PR — worth a follow-up issue.
- Moving harness worktrees out of `.claude/` — not repo-controllable.
- Any change to `verify.yml` or to ops-30's fix.
