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

The local pre-push husky hook already runs the FULL `npm run verify` battery on
every push (typecheck + all tests + e2e + build). The per-PR cloud `verify.yml`
run was therefore re-doing work that already passed locally — paying Actions
minutes for redundant insurance. Plans 101/103/118 attacked the *cost per run*
(doc-only skip, scope-gated legs, test-impact selection, draft-by-default). This
plan attacks the *number of runs* directly: **don't run cloud CI at all unless
asked**.

- **User (maintainer):** stops burning Actions minutes on every PR push. A
  normal PR now bills **0 CI minutes**; you opt in to a cloud check only when you
  want one (e.g. right before merge, or a change you couldn't fully verify
  locally).
- **Technical:** PR-CI cost drops from `(PR push events) × (~6–15 min)` to
  `(explicitly-requested runs) × (~6–15 min)`. The pre-push hook remains the real
  gate, so nothing is un-covered.
- **Architectural:** locks in "local pre-push is the authoritative gate; cloud
  CI is on-demand insurance + release/cross-OS pulses." Compatible with the
  staged `main` branch-protection ruleset, which **excludes required status
  checks** (`brand/ruleset-main.json`, com-4) precisely so opt-in / doc-only PRs
  that never run `verify` can't deadlock.

## Architectural impact

- **`verify.yml` is now opt-in.** Two ways to fire it:
  1. **`run-ci` label** on a PR — the `pull_request` trigger gains `labeled`
     (so adding the label fires immediately), and the job `if:` requires the
     label present + non-draft. `synchronize` re-runs while the label stays on.
  2. **`workflow_dispatch`** — manual run (Actions tab / `gh workflow run
     verify.yml --ref <branch>`). A dispatch has no PR diff, so the scope
     detector sets every scope `true` (full battery) and the `vitest --changed`
     steps fall back to a full run when `base.sha` is empty.
- **Unlabeled PRs** still *evaluate* the workflow but the job is skipped by the
  `if:` → zero runner minutes. No required status check on `main` gates merge,
  so a skipped job never blocks.
- **`release.yml` is now the complete-verification boundary.** Because PRs no
  longer run cloud CI, the full + cross-OS battery is concentrated on the tag.
  `publish` gates on `needs: [verify, cross-os-verify, mobile-e2e,
  companion-apk-build]`:
  - `verify` — full `npm run verify` on Ubuntu (typecheck + lint + all tests +
    e2e + a11y + build); upgraded from the old `verify:quick` and given a 30-min
    cap + a Playwright-chromium install for the e2e leg.
  - `cross-os-verify` — `verify:quick` + build on **macOS** and **Windows**
    (matrix; mirrors `cross-os.yml`). Restores the cross-OS gate plan 103 had
    moved off the release path — releases are public-beta, so the macOS 10×
    minutes are worth it per (infrequent) tag.
  - `mobile-e2e` — `npm run test:e2e:mobile` (Pixel 7 / iPad Pro 11), Ubuntu,
    run unconditionally per tag.
  A red leg on any deployer OS blocks the release. `cross-os.yml` stays as the
  between-releases weekly pulse + ad-hoc dispatch.
- **Still automatic, otherwise untouched:** `pr-title-lint.yml` (every PR — cheap
  title gate), `app.yml` (Flutter companion CI on `apps/android/**` — the only
  automated coverage for the app; no local hook runs `flutter analyze`/`test`),
  `cross-os.yml` (weekly Sunday cron + manual dispatch).
- **Reversibility:** revert the `verify.yml` trigger/`if:` edits to restore
  auto-on-PR; revert the `release.yml` job additions to drop back to the
  Ubuntu-only `verify:quick` release gate. The `run-ci` label is a repo label;
  deleting it just removes the opt-in handle (dispatch still works).

## Invariants to preserve

- Job `name:` stays `npm run verify` (`.github/workflows/verify.yml`) — kept
  stable in case a required status check is added to branch protection later.
- The scope detector and `vitest --changed` steps MUST tolerate an empty
  `github.event.pull_request.base.sha` (the `workflow_dispatch` case) — guarded
  by the `if [ -n "$BASE" ]` fallbacks.
- The doc-only `paths-ignore` block (plan 101) stays — second layer so a
  `run-ci`-labeled doc-only PR still skips the battery.

## Test plan

### Automated coverage

CI workflow YAML is not unit-testable in this repo (no act/workflow harness).
Coverage is the workflow's own behaviour, verified by the acceptance walkthrough
below + the fact that the validator/test scripts the workflow invokes are
themselves covered (`scripts/validate-commit-msg.mjs` via `npm run test:hooks`,
the vitest suites it runs). No app code changes → no new vitest/e2e specs. This
is called out explicitly per the testing-discipline rule: the change is CI
config + docs only.

### Manual acceptance walkthrough

1. **Open a PR with no label** → `verify` workflow appears but the job is
   **skipped** (no billed minutes); `pr-title-lint` runs.
2. **Add the `run-ci` label** → `verify` fires once, scope-filtered to the
   diff. Push another commit while labeled → it re-runs.
3. **Remove the label, push again** → no `verify` run.
4. **Actions tab → Verify → Run workflow on a branch** (or `gh workflow run
   verify.yml --ref <branch>`) → runs the **full** battery (all scopes), no PR
   needed.
5. **Push a `vX.Y.Z` tag** → `release.yml` runs the complete battery and only
   publishes if ALL legs pass: `verify` (Ubuntu full), `cross-os-verify`
   (macOS + Windows), `mobile-e2e` (Ubuntu), and `companion-apk-build`. Force a
   red on any one (e.g. a Windows-only failure) → `publish` is skipped and no
   GitHub Release lands.
6. **Push to `apps/android/**`** → `app.yml` still runs (unchanged).

## Out of scope

- Server-side branch protection on `main` — **enabled 2026-06-14** (ruleset
  id 17654264, after the GitHub Pro upgrade; tracked as `com-4`). The ruleset
  excludes required status checks, so it composes with this plan — no required
  check means opt-in PRs that never run `verify` can't deadlock.
- Changing `cross-os.yml` cadence, `app.yml`, or `pr-title-lint.yml` — left
  as-is by decision.

## Ship notes

(Filled in when status flips to `stable`.)
