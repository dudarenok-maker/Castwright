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

GitHub Actions metered usage hit ~$17 for May 2026 on a steeply accelerating
curve — the 2,000-min free tier is exhausted and Linux runner minutes (the only
thing `verify.yml` bills per-PR) dominate. Plan 103 already cut per-run work
(scope-gated legs, caching, doc-only skip, cross-OS off the per-PR path). This
round attacks the two axes 103 left open: **how many runs fire** and **how much
of the suite each run executes**.

- **Technical / cost:** PR-CI cost is `(non-draft PR push events) × (~6–15 min)`.
  Making draft-by-default the norm collapses a PR from "one run per push" to one
  run total; batching a round of parallel agent branches into one integration PR
  collapses N PRs into one. Test-impact selection (`vitest --changed`) makes each
  run's test time scale with the *diff*, not the (ever-growing) suite.
- **Technical:** explicit `timeout-minutes` on every job removes the timeout
  double-charge (a run that dies at the cap bills the cap for nothing, then needs
  a re-run) and the 360-min runaway exposure on three previously-uncapped jobs.
- **Architectural:** locks in "the authoritative full suite runs locally
  (pre-push) and weekly (cross-os); PR CI runs the diff-affected subset." No app
  code changes.

## Architectural impact

- **No new seams.** Levers 2/3 are *conventions* documented in `CLAUDE.md` +
  `CONTRIBUTING.md` (the repo enforces process by convention, not bots — there is
  no branch-protection wall on the Free plan). Levers 1/4 are config edits.
- **Invariants preserved:**
  - `verify.yml`'s job `name:` stays exactly `npm run verify` — it is the
    branch-protection required-check identity (renaming silently drops the gate).
  - The draft-skip mechanic (`if: draft == false` + `ready_for_review` trigger)
    is plan-103 machinery; this round *adopts* it as the default, it does not
    change it.
  - The plan-45 server pool tuning (`maxForks` cap, `retry: 1`, slow-config
    mirror) is untouched — `--changed` is an orthogonal flag layered on top.
- **Reversibility:** revert the `timeout-minutes` values, the two `--changed`
  step bodies, and the `forceRerunTriggers` block; delete the convention
  paragraphs. Each is independent and self-contained.

## Invariants to preserve

1. `verify.yml` job name is `npm run verify` (`.github/workflows/verify.yml:56`).
2. Every expensive leg keeps its scope `if:` (plan 103) — `--changed` narrows
   *within* a leg that already decided to run; it does not replace the gate.
3. `vitest.config.ts` `forceRerunTriggers` MUST re-list the vitest defaults
   (`**/package.json/**`, `**/{vitest,vite}.config.*/**`) alongside the added
   `**/src/test/setup.ts` — setting the key replaces the defaults, and losing the
   package.json/config triggers would let a dep bump skip affected tests.
4. The setup file is the *only* added trigger needed: it is runner-injected, not
   import-reachable, so `--changed` can't see it via the module graph. Shared
   fixtures/mocks (`src/data/**`, `src/mocks/**`) are statically imported, so the
   graph already covers them — do NOT add them (it would force a full run on
   every fixture tweak and erode the lever).
5. e2e stays scope-gated — do NOT apply Playwright `--only-changed` to
   app-source changes (a spec's import graph ≠ the app source the browser loads,
   so it would silently skip e2e).
6. Server vitest configs need NO `forceRerunTriggers` edit — they have no
   `setupFiles`, so vitest's default triggers (package.json + config) already
   force a full run on the only non-graph-reachable inputs.

## Test plan

### Automated coverage

This round is CI-config + process documentation. No app behaviour changes, so no
unit/e2e test is meaningful — the existing harnesses (`test:hooks`, Vitest,
Pester, Playwright) do not cover workflow YAML or `CLAUDE.md`/`CONTRIBUTING.md`
prose, and adding a YAML-lint test would be scaffolding beyond the change. The
guarantees are verified manually + observationally (below). `npm run verify`
green on the branch confirms the `vitest.config.ts` edit is valid and the full
battery still passes.

### Manual acceptance walkthrough

1. **Timeouts parse.** `actionlint .github/workflows/*.yml` clean (or a YAML
   sanity parse where actionlint isn't installed). `verify.yml` → 20,
   `pr-title-lint` → 5, `release` verify → 20 / publish → 15.
2. **`--changed` narrows (local, deterministic).**
   - Add a comment to one component with a colocated test, commit it, then
     `npx vitest run --changed HEAD~1` runs *only* that component's test(s).
   - Touch `src/test/setup.ts` → `npx vitest run --changed HEAD~1` runs the
     **full** frontend suite (proves the `forceRerunTriggers` guard).
   - From `server/`, repeat against main + slow configs.
3. **Full suite green.** `npm run verify` passes on the branch (the safety net
   Lever 4 leans on is intact).
4. **Draft mechanic (cheap, real).** Open a throwaway draft PR with a trivial
   `src/` change → no `verify` run queues in the Actions tab. `gh pr ready <n>`
   → exactly one `verify` run fires; its frontend-leg log shows only the
   diff-affected tests ran. Close without merging.
5. **Observational.** Over the following weeks the metered-usage chart flattens
   relative to the May 18–26 ramp — the real success metric.

## Out of scope

- Dropping `build` / `e2e` from PR CI (per-run trim) — Linux-only build-break
  exposure (Windows dev box is case-insensitive). Recorded in `docs/BACKLOG.md`
  "Won't (this round)".
- Splitting `verify.yml` into parallel jobs — faster wall-clock but *more* billed
  minutes (plan 103 `verify.yml:15-19`).
- Playwright `--only-changed` for e2e — unsafe for app-source changes.
- A Linux nightly full-`test:all` cron (tighter safety-net window than the weekly
  `cross-os.yml`) — opt-in later if the weekly window proves too loose.
- Wiring `--changed` into the local `verify-cache` steps — local pre-push stays
  full (it is the authoritative safety net).

## Ship notes

(Filled in when status flips to `stable`: shipped date, commit SHA, any delta
vs. this spec.)
