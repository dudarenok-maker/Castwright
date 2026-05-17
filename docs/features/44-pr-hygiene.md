---
status: stable
shipped: 2026-05-18
owner: null
---

# Pull request hygiene

> Status: stable
> Key files: `CONTRIBUTING.md`, `.github/pull_request_template.md`, `.github/workflows/pr-title-lint.yml`, `scripts/validate-commit-msg.mjs`, GitHub repo settings (out-of-tree)
> URL surface: none
> OpenAPI ops: none

## Benefit / Rationale

- **User (developer-facing):** every PR opened against `main` starts pre-populated with the Summary / Test plan structure PRs #1-#4 already use, so reviewers (the user, future-me, future-anyone) don't have to ask "what changed and what did you test?" — it's the template's first prompt.
- **Technical:** the PR title is gated against the same Conventional-Commits validator (`scripts/validate-commit-msg.mjs`) that the local `commit-msg` hook uses. GitHub's PR title is independent of the squash/merge commit subject, so the local hook alone leaves a hole; the workflow closes it.
- **Architectural:** server-side repo settings (delete-branch-on-merge, merge-commit-only) move two soft conventions into hard enforcement once the user approves the toggle. `git log --merges` stays interpretable (`Merge pull request #N from <branch>` is the only shape) and stale branches don't pile up — both are read-throughs to plan 38's "linear, scope-tagged history" goal. The repo settings are an out-of-tree change applied via `gh repo edit`; the in-tree artifacts (template + workflow + docs) are the load-bearing pieces and are useful even before the settings flip.

## Architectural impact

- **New seams / extension points:**
  - `.github/pull_request_template.md` — GitHub picks this up automatically when the user clicks "New pull request". No code path; it's pure markdown that GitHub injects into the textarea.
  - `.github/workflows/pr-title-lint.yml` — runs on `pull_request` events (`opened`, `edited`, `synchronize`, `reopened`). Reuses the existing `scripts/validate-commit-msg.mjs` module — no new validation logic, no new dependency surface.
- **Invariants preserved:**
  - Plan 38's commit-message convention is the single source of truth for the title format. The PR-title workflow is a thin caller of the existing validator — it cannot drift independently. If `SCOPES` or `TYPES` change in `scripts/validate-commit-msg.mjs`, both the local hook and the PR-title workflow follow in lockstep.
  - The four existing hooks (`commit-msg`, `pre-commit`, `pre-push`, plus husky's `prepare`) are untouched. The PR-title workflow is additive, runs server-side, and does not block local development.
  - No change to merge-commit shape: PRs still produce `Merge pull request #N from <head-ref>` commits on `main`. Disabling squash/rebase merge buttons in the GitHub UI prevents accidental policy drift via the wrong button click — the *option that's left* matches the existing pattern.
- **Migration story:** none — every PR opened before this plan landed (#1-#4) already follows the convention informally. The template + workflow lock in what's already happening. Pre-existing branches do NOT need rewriting.
- **Reversibility:**
  - Delete `.github/pull_request_template.md` → PR textarea is blank again, contributors fall back to the CONTRIBUTING.md convention.
  - Delete `.github/workflows/pr-title-lint.yml` → server-side title gate is gone, local `commit-msg` hook still catches the typical case (PR title = first commit subject).
  - `gh repo edit --enable-squash-merge --enable-rebase-merge --no-delete-branch-on-merge` reverts the repo-setting changes. No data migration.

## Invariants to preserve

1. **The PR-title workflow MUST call `scripts/validate-commit-msg.mjs` directly, not a re-implementation.** If a new contributor adds an `amannn/action-semantic-pull-request`-style third-party action, the title rule diverges from the commit-msg hook. Enforced by `.github/workflows/pr-title-lint.yml:23-27` (the `node scripts/validate-commit-msg.mjs` step). Adding a new type/scope in `scripts/validate-commit-msg.mjs` MUST automatically apply to PR titles with no workflow edit — that's the whole point of the indirection.
2. **The PR template MUST list a `## Summary` section first and a `## Test plan` section second.** PRs #1-#4 use this shape; the regression plans cite it; this plan's "Pull requests" section in CONTRIBUTING.md cites it. Reordering or renaming breaks the reader's habit and orphans the cross-references.
3. **The repo MUST allow only "Create a merge commit" as a merge button option.** Plan 38's `git log --grep="(scope)"` workflow depends on the original commits surviving the merge. Squash collapses them; rebase loses the merge commit. Either setting flipped back to true breaks the reproducible scope-walk.
4. **`deleteBranchOnMerge` MUST stay enabled at the repo level.** Once a branch is merged, `git branch --list 'feat/server-*'` should list *open work only* — leaving merged branches around defeats the at-a-glance scope discovery from plan 38's branching model.
5. **The PR-title workflow MUST be skip-eligible for auto-generated merge titles.** GitHub auto-generates "Merge branch …" titles in some flows (dependabot, web-UI fork merges). `validate-commit-msg.mjs:30` already exempts `^Merge ` / `^Revert ` / `^fixup! ` / `^squash! ` — the workflow inherits this for free by going through the validator. Do not add a separate workflow-level skip-list.

## Test plan

### Automated coverage

- **`scripts/tests/validate-commit-msg.test.mjs`** (unchanged) — the existing validator unit suite locks the rules used by both the local `commit-msg` hook and the new PR-title workflow. Adding a new type/scope is already covered by the "every documented type accepted" / "every documented scope accepted" cases in `scripts/tests/validate-commit-msg.test.mjs:1-150`.
- **No new test harness needed.** The workflow YAML is wired to invoke the same Node module — exercising the module locally exercises the workflow's behaviour. Writing a GitHub-Actions-runtime test would require committing-and-pushing iterations against the live `pull_request` event, which is more cost than it earns for a thin caller.
- **PR template has no executable surface.** It's markdown that GitHub injects into the textarea; nothing to test.

### Manual acceptance walkthrough

1. **Template appears on PR creation.**
   - Push a branch with one commit. Open `https://github.com/dudarenok-maker/AudioBook-Generator/compare/<branch>`.
   - Expected: the PR description textarea is pre-filled with the Summary / Test plan / Plan reference template. The user can edit before submitting.
2. **Conforming PR title passes the workflow.**
   - Open a PR titled `feat(frontend): add foo`. Wait for the "PR title lint" check.
   - Expected: the check completes green within ~30 s. No annotation on the PR.
3. **Malformed PR title fails the workflow.**
   - Edit the same PR's title to `add foo` (no type, no scope). The workflow re-runs on the `edited` event.
   - Expected: the check fails with the validator's standard help block (showing allowed types and scopes). The PR cannot be merged green-only — the user can still force-merge, but the failure is visible in the merge dialog.
4. **Merge-button options are narrowed.**
   - On any open PR, scroll to the merge box.
   - Expected: the dropdown shows "Create a merge commit" only. "Squash and merge" and "Rebase and merge" buttons are not offered.
5. **Branch auto-deletes after merge.**
   - Merge any PR.
   - Expected: GitHub deletes the head branch automatically. `git branch -r --merged main` no longer lists `origin/<branch-name>` after a `git fetch -p`.
6. **Auto-generated merge title is exempt.**
   - Trigger a merge-commit PR (e.g. a dependabot bump that uses `Merge branch …` shape). The workflow should accept the title verbatim — same exemption as the local `commit-msg` hook.

## Out of scope

- **Full `npm run verify` CI workflow.** Tracked separately as `docs/BACKLOG.md` → Could #1 ("CI integration for the test suite"). The PR-title lint workflow is independently valuable and lands now; the heavier verify-on-PR workflow is its own piece of work.
- **Branch protection rules** (required status checks, required reviews, no force-push). The repo is on a GitHub Free plan, so `repos/.../branches/main/protection` returns 403. Wake this if the repo flips to GitHub Pro or goes public.
- **CODEOWNERS file.** Single-developer repo today. Wake when a second human reviewer is added.
- **Auto-link PR body to the regression plan via a bot.** The template prompts for the plan reference manually; automating it would need a bot that parses `docs/features/*.md` for the new plan in the diff. Not worth the maintenance for a one-developer cadence.
- **Issue templates** (`.github/ISSUE_TEMPLATE/`). Bugs are out-of-band per CLAUDE.md — the user files them in chat, not in GitHub Issues. Wake when GitHub Issues becomes the bug-tracking surface.

## Ship notes

- Shipped 2026-05-18.
- Five in-tree artifacts: this plan, `.github/pull_request_template.md`, `.github/workflows/pr-title-lint.yml`, CONTRIBUTING.md "Pull requests" section, CLAUDE.md cross-link in the branching workflow section.
- Out-of-tree repo settings (to apply once via `gh repo edit dudarenok-maker/AudioBook-Generator`):
  ```
  --delete-branch-on-merge
  --enable-squash-merge=false
  --enable-rebase-merge=false
  ```
  These move two soft conventions into hard enforcement. Re-state them in this section if a future contributor wants to reproduce the setup on a fork. Reversible with `--no-delete-branch-on-merge --enable-squash-merge --enable-rebase-merge`.
- One follow-up tracked in `docs/BACKLOG.md`: full `npm run verify` CI workflow (Could #1) will subsume the PR-title workflow as a separate job in the same actions file once it lands. No action needed until then.
