---
status: stable
shipped: 2026-05-22
owner: null
---

# Doc-only PR fast-path (skip verify + e2e-mobile)

> Status: stable
> Key files: `.github/workflows/verify.yml`, `.github/workflows/e2e-mobile.yml`, `CONTRIBUTING.md`, `CLAUDE.md`
> URL surface: GitHub Actions — pull_request event
> OpenAPI ops: none

## Benefit / Rationale

- **User (maintainer):** doc-only PRs (regression-plan edits, archive moves, CLAUDE.md tweaks, PR-template changes) no longer burn 10–15 min waiting for `verify.yml` + up to ~15 min for `e2e-mobile.yml`. Merge clears in seconds once the title-lint job reports green.
- **Technical:** GitHub Actions `paths-ignore` is webhook-side — the workflow run is never queued, so we don't pay runner minutes for known-no-op invocations. With several doc-PRs landing per session-day, this is the dominant CI cost saver on the Free tier.
- **Architectural:** the gate stays "PR required + title valid + no conflicts" without weakening it. The full `npm run verify` battery is still the pre-push gate locally on every branch, so a doc PR that somehow broke a test would catch it at push time, before CI sees the branch.

## Architectural impact

- **New seam:** `paths-ignore` block on the `pull_request:` trigger of `verify.yml` and `e2e-mobile.yml`. Three globs:
  - `docs/**` — all planning + archive + feature docs
  - `*.md` — root-level only (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`)
  - `.github/*.md` — `.github/pull_request_template.md` + any sibling
- **Invariants preserved:**
  - `pr-title-lint.yml` runs unconditionally on every PR (no path filter) — title convention still enforced.
  - GitHub's native `mergeable` status surfaces conflicts without any workflow.
  - The moment a non-doc file is touched in the same PR, the full `verify` runs as before (GitHub's `paths-ignore` triggers a skip only when **all** changed files match).
  - `release.yml` is tag-triggered; unaffected.
- **Reversibility:** delete the `paths-ignore` block from both workflows. Single commit, no migration.

## Invariants to preserve

- `paths-ignore` list must stay aligned in both `verify.yml` and `e2e-mobile.yml` — drift means a doc PR could end up skipping one workflow but not the other, which is confusing rather than dangerous but worth keeping clean. Both lists live in their YAML files; CONTRIBUTING.md references the workflow files rather than duplicating the YAML.
- Do **not** broaden the doc set to `**/*.md` — that would swallow shipped artifacts like `server/tts-sidecar/voices/kokoro/README.md`, which can ride alongside code changes. Root-level + `docs/**` + `.github/*.md` is the exact intended surface.
- Do **not** add `.github/workflows/**` to the ignore list — a meta-change to a workflow must run full verify so the workflow can't gut itself.

## Test plan

### Automated coverage

This change is GitHub-side workflow configuration with no in-repo executable surface — there is no Vitest / Pester / Playwright shape that exercises `paths-ignore`. The contract is documented here and in the workflow files' header comments; verification is the post-merge smoke walkthrough below.

If the repo gains a workflow-lint harness in the future (e.g. `actionlint`), the `paths-ignore` block should land there as well.

### Manual acceptance walkthrough

1. **Land this PR.** Since the PR itself touches `.github/workflows/**`, the full `verify` runs on the PR that ships the skip — that's the right canary.
2. **Open a doc-only follow-up PR** (e.g. a one-line CLAUDE.md tweak). Expected: `gh pr checks <N>` shows only the `pr-title-lint` job — `verify` and `e2e-mobile` show no run. Merge clears once title-lint goes green.
3. **Open a one-line code PR in the same session.** Expected: both `verify` and `e2e-mobile` queue normally; PR cannot merge until `verify` is green (informal — no branch-protection wall on Free plan).
4. **Open a mixed PR** (one doc file + one source file). Expected: both `verify` and `e2e-mobile` queue normally — `paths-ignore` requires every changed file to match.

## Out of scope

- Removing `continue-on-error: true` from `e2e-mobile.yml` — separate concern; lives on the BACKLOG as a "promote to blocking" follow-up.
- A `path-aware` fast-path that runs `lint` only on doc PRs — survey rejected in favour of pure skip (the gain over "skip entirely" is minimal once docs are excluded from prettier/eslint anyway).
- Re-evaluating the full `verify` battery's runtime — separate optimisation track ([docs/features/archive/50-verify-cache.md](50-verify-cache.md) already covers the cold/warm story).
- Branch-protection rules. The repo is on GitHub Free with no protected-branches API; revisit when the repo flips to Pro or goes public.

## Ship notes

Shipped 2026-05-22 alongside the `paths-ignore` edits to `.github/workflows/verify.yml` and `.github/workflows/e2e-mobile.yml`. CONTRIBUTING.md grew a "Doc-only PR fast-path" subsection under `## Pull requests`; CLAUDE.md's `## Commit gate` section gained a one-paragraph pointer to this plan. Commit SHA + merged PR # stamped after merge (typical pattern — the merge commit is created by GitHub).
