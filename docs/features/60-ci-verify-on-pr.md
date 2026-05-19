---
status: stable
shipped: 2026-05-19
owner: null
---

# CI verify-on-PR (GitHub Actions)

> Status: stable
> Key files: `.github/workflows/verify.yml`
> URL surface: none (CI infrastructure)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** n/a — this is operator-facing infrastructure, not user-visible behaviour.
- **Technical:** eliminates the "works on my machine" gap. Every PR runs `npm run verify` on a clean Ubuntu runner before merge — typecheck, lint, frontend / server / hooks unit tests, Playwright e2e (including the visual baselines shipped 2026-05-17 in `e2e/visual.spec.ts`), and production build. PRs that break any of these are blocked from merge via GitHub branch protection.
- **Architectural:** pairs with the visual baselines and the verify-cache plans (50 + 54). Without CI, the visual baselines are a tree-falling-in-a-forest — only the author runs them. With CI, every PR's contributor sees the same gate the maintainer would see at push time.

## Architectural impact

- **New seam:** `.github/workflows/verify.yml` is the second status-check workflow on PRs (alongside [`pr-title-lint.yml`](../../.github/workflows/pr-title-lint.yml)). Once branch protection is configured to require the `npm run verify` check, merges to `main` are gated on it.
- **Invariants preserved:**
  - The workflow shells out to `npm run verify` verbatim — same command the pre-push hook runs locally. No CI-specific test path; what fails in CI fails locally and vice versa.
  - `npm run verify` is the verify-cache runner (`scripts/verify-cache.mjs`, plan 50). On CI each runner is ephemeral, so the cache file (`.verify-cache.json`) never survives across runs — every CI run is effectively cold. That is intentional: PR CI must re-validate every step, not trust a cache from a different commit.
  - `test:scripts` (Pester) and `test:sidecar` (pytest) skip with a banner when their toolchains aren't bootstrapped on the runner. Fresh Ubuntu runners don't have Pester 5 or the sidecar venv, so both legs no-op cleanly. The cross-OS [`release.yml`](../../.github/workflows/release.yml) workflow is the source of truth for those harnesses on a fully-bootstrapped runner.
- **Reversibility:** delete `.github/workflows/verify.yml` and remove the required-status-check rule from branch protection. No production impact; reverts to "pre-push hook is the only gate" (which is what the repo had until plan 60 shipped).

## Invariants to preserve

1. The workflow MUST execute `npm run verify` exactly — not a hand-rolled subset of the steps the pipeline runs. If `package.json`'s `verify` script or `scripts/verify-cache.mjs` changes the pipeline shape, the CI gate picks it up automatically.
2. The workflow MUST run on `pull_request` events `opened`, `synchronize`, and `reopened` targeting `main` (matches the gating intent — every commit pushed to a PR re-runs the gate).
3. `ubuntu-latest` only — explicitly NOT a cross-OS matrix. Cost concern: matrix runs three runners. The release workflow already covers cross-OS verify on tag push (Ubuntu + macOS + Windows in [`release.yml`](../../.github/workflows/release.yml) lines 22-72), so PR CI doesn't need to repeat that.
4. The Node setup MUST cache `node_modules` via `actions/setup-node@v4`'s `cache: 'npm'` keyed on both `package-lock.json` and `server/package-lock.json` — the same dependency-path pattern `release.yml` uses.
5. The Playwright chromium download MUST be cached at `~/.cache/ms-playwright`, keyed on the root `package-lock.json` hash (`@playwright/test` version lives there). `restore-keys` provides graceful fallback when the cache key drifts.
6. ffmpeg MUST be installed before `npm run verify` — `server/src/tts/mp3.ts` shells out to it, and the server pretest hook (`scripts/preflight-ffmpeg.cjs`) refuses to run without it on PATH.

## Test plan

### Automated coverage

The workflow IS the test plan. There is no Vitest / Pester / pytest spec for "did CI run on this PR?" — the workflow's presence and the GitHub status check on the PR are the assertion. Concretely:

- Open a PR against `main` → the `verify / npm run verify` check appears in the PR's Checks tab.
- If `npm run verify` fails on the PR's HEAD commit → the check status flips to `failure` → merge is blocked (once branch protection is configured to require this check).
- If `npm run verify` passes → check status flips to `success` → merge unblocks.

The PR landing this plan is its own first execution of the workflow — a PR that adds a CI check is a PR that the new CI check runs against.

### Manual acceptance walkthrough

1. **Open this plan's PR.** Within 30 seconds the `verify / npm run verify` check appears under "Some checks haven't completed yet" in the PR's Checks tab.
2. **Wait for the run.** Expected duration on a cold runner: 5–10 minutes (`npm ci` ~30 s, ffmpeg install ~10 s, Playwright chromium download ~30 s when uncached, `npm run verify` itself ~3–5 min for the full pipeline). Warm runs with cache hits drop the install legs to near-zero but `npm run verify` itself doesn't speed up — each CI runner starts with an empty `.verify-cache.json`.
3. **Confirm pass.** Check status flips to green; PR merge button enables (once branch protection requires this check).
4. **Smoke-test the failure path** (optional, post-merge): push a commit that intentionally breaks a test (e.g. flip an assertion in `src/lib/router.test.ts`) → expect the check to flip red, merge to be blocked. Revert the commit → check flips green.

### Cold-run expected duration

`npm run verify` on a clean Ubuntu runner with the `.verify-cache.json` empty (which is the steady state for ephemeral CI runners): ~3–5 minutes for the verify pipeline itself, plus ~1–2 minutes of setup (Node + ffmpeg + npm install + Playwright). Total cold wall-clock: under 10 minutes per the BACKLOG acceptance criterion. The warm target (under 5 min) only applies to local runs with a populated cache file — CI runs are functionally always cold; the npm + Playwright caches are the only warm levers, and they affect setup time, not the verify pipeline itself.

## Out of scope

- **Windows / macOS runner matrix.** Cost: 3× the CI minutes for every PR. The release workflow already does cross-OS verify on tag push (see [`release.yml`](../../.github/workflows/release.yml) lines 22-72), so PR CI doesn't need to repeat the cross-OS check on every push.
- **Cache-strategy detail tuning.** `actions/setup-node@v4` with `cache: 'npm'` is the standard pattern; the Playwright cache is a straightforward `actions/cache@v4` invocation keyed on the lockfile hash. We deliberately do NOT cache `node_modules` directly (npm cache + `npm ci` is the documented best practice — `node_modules` caches across runs are fragile because postinstall steps can drift).
- **Pester / pytest setup on the CI runner.** Both harnesses skip with a banner on an unbootstrapped runtime, which is fine for PR CI — the local pre-push gate and the release workflow's cross-OS matrix are the gates for those harnesses.
- **Sharded e2e runs.** With 19 e2e specs at ship time the full e2e run lands around 60 s cold; sharding would add complexity without meaningful wall-clock savings. Wake this when the e2e run exceeds ~5 min.
- **Required-status-check configuration.** This plan ships the workflow file; flipping `verify / npm run verify` to required in branch protection is a one-time GitHub UI step the maintainer does after the first green run.

## Ship notes

Shipped 2026-05-19 as Wave 2.S1 of the v1.4.0 alpha-launch slate. Commit SHA filled in after the PR merges to `main`. Closes BACKLOG Could #18 ("CI integration for the test suite"). The workflow runs against this very PR as its first execution — the PR landing the CI gate is the PR the CI gate runs against.
