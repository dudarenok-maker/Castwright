---
status: stable
shipped: 2026-05-18
owner: null
---

# Vitest pool tuning + one-retry policy

> Status: stable
> Key files: `server/vitest.config.ts`, `vitest.config.ts`, `docs/features/37-e2e-playwright.md` (sibling test infra plan)
> URL surface: none
> OpenAPI ops: none

## Benefit / Rationale

- **User (developer-facing):** pre-push (`npm run verify`) stops failing with intermittent "Worker exited unexpectedly" / tinypool crashes — i.e. the user no longer has to retry a clean push because the verify pipeline self-flaked. Concretely, the symptom that motivated this plan was 815/851 server-suite tests passing on a docs-only branch before a worker died and the whole pipeline failed; a retry of the identical commit would have re-run typecheck + frontend + sidecar + Pester + e2e + build for nothing.
- **Technical:** caps Vitest's forks pool at 4 (down from the default = number-of-logical-CPUs, which is 16 on the dev box). The server suite is the one that spawns ffmpeg subprocesses (`mp3.test.ts`, `build-m4b.test.ts`, `build-mp3-folder.test.ts`, `build-mp3-zip.test.ts`, `chapter-audio.test.ts`, `voice-sample.test.ts`, `synthesise-chapter.test.ts`, `spawn-sidecar.test.ts`) plus supertest HTTP servers. 16 of those running in parallel exhausts pipe/handle budgets and lands the OS in a state where any single worker can be killed. Capping to 4 gives ffmpeg and Node room to coexist. `retry: 1` is the residual safety net: any flake that survives the cap gets one in-process retry instead of forcing a full pre-push re-run.
- **Architectural:** keeps the three-tier commit gate (commit-msg → pre-commit → pre-push) usable. If `npm run verify` flakes more often than once per ~10 invocations, contributors learn to bypass it (`--no-verify`), which silently breaks the regression contract. The tuning preserves the gate's *credibility*, which is the actual load-bearing invariant — the gate only works if developers trust it. Also locks in a documented seam (`poolOptions.forks.maxForks`) so future test additions don't quietly re-introduce the same OOM-by-concurrency pattern as the suite grows.

## Architectural impact

- **New seams / extension points:**
  - `server/vitest.config.ts` — explicit `pool: 'forks'` + `poolOptions.forks.{maxForks: 4, minForks: 1}` + `retry: 1`. The cap is a knob; if a future contributor adds 50 more pure-helper tests, they can raise it. The cap exists because of the subprocess-spawning tests, not the count.
  - `vitest.config.ts` (frontend) — `retry: 1` only. Pool left at Vitest defaults because the jsdom suite is CPU-bound and has no subprocess spawn pattern.
- **Invariants preserved:**
  - CLAUDE.md "Commit gate" three-tier shape (`commit-msg`, `pre-commit`, `pre-push`) is unchanged. `npm run verify`, `npm run verify:fast`, `npm run verify:quick` all keep their existing meaning.
  - CLAUDE.md "Testing discipline (REQUIRED for every change)" — every PR still adds coverage; retries do NOT replace the test-discipline contract. `retry: 1` is for transient infrastructure flakes (worker pipe death, subprocess spawn lottery), not for "this test fails 50% of the time and I'm hiding it." A genuine flake that retries-and-passes is still visible in Vitest's output — see invariant #4 below for the watching contract.
  - Pre-commit gate (`npm run verify:fast`) still runs the validator + frontend + server tests. Sub-5s on a warm cache. The pool cap *helps* server-suite cold runs since fewer workers means less startup-cost amortization noise.
  - The five test harnesses (frontend Vitest, server Vitest, sidecar pytest, Pester, Playwright e2e) all continue to exist. The cap touches only the two Vitest harnesses.
- **Migration story:** none. No on-disk format change, no slice shape change, no env-var change. Existing tests run as-is.
- **Reversibility:** trivial. Delete the `pool` / `poolOptions` / `retry` keys from `server/vitest.config.ts` and the `retry` key from `vitest.config.ts` — Vitest falls back to its defaults. No data to migrate.

## Invariants to preserve

1. **`server/vitest.config.ts:22-28` MUST cap `poolOptions.forks.maxForks` at 4 or lower.** This is the root-cause guardrail. Raising the cap, switching the pool to `threads` without re-validation, or removing the `pool: 'forks'` key reverts to the default-of-N-logical-CPUs behaviour that lands the OOM. If a future contributor adds a workload that legitimately needs higher parallelism, they should split it into a separate config file rather than raising this cap, so the subprocess-spawning tests stay capped.
2. **`server/vitest.config.ts:29` MUST keep `retry: 1` (or higher).** This is the residual safety net for transient pipe/handle failures the cap doesn't catch. `retry: 0` is the Vitest default and recreates the "one death fails the whole verify" pattern. If a contributor sees flake counts trending up, the response is to fix the underlying flake (see invariant #4), NOT lower `retry`.
3. **`vitest.config.ts:20` (frontend) MUST keep `retry: 1`.** Same reason — absorbs transient jsdom/timer/microtask scheduling flakes inside a single verify run. Pool concurrency is intentionally NOT capped on the frontend side because jsdom suites are CPU-bound, not subprocess-bound; capping there would slow the happy path without buying stability.
4. **Retries MUST stay visible in test output.** Vitest's default reporter shows `(retry x/N)` for any test that retried. If a contributor switches to a quieter reporter that hides retries, the safety net silently masks real flakes — which is the failure mode the user explicitly flagged. Reporter changes must preserve retry visibility. (Today, the default reporter does this for free; this invariant exists to lock in the property if reporter config is ever added.)
5. **The pool cap is a SERVER-suite knob; do not copy-paste it to the frontend.** Conversely, do not remove `retry: 1` from the frontend on the theory that "only the server has flakes" — the residual flake budget on the frontend is non-zero (jsdom + microtask races) and the retry has no cost on green runs.

## Test plan

### Automated coverage

- **No new test file is added or required.** This plan tunes the test harness itself — it has no executable surface beyond the Vitest config keys. Existing tests are the regression: if `npm run test:server` runs to completion N times in a row (where it previously crashed mid-suite), the tuning works. The success criterion is observability, not assertion-able state. Vitest's own contract guarantees: `pool: 'forks'` is honored (covered by Vitest's own tests at the framework level), `maxForks: 4` is honored (ditto), `retry: 1` is honored (ditto). Re-asserting framework guarantees in this repo would be busywork.
- **What WOULD warrant a test here:** a project-local wrapper that mutated `maxForks` based on env vars or a `vitest.config.ts` factory function with branching logic. Neither exists. The config is a flat object literal with documented constants.
- **What the test plan looks like in practice:** the existing suites under `src/**/*.test.{ts,tsx}` and `server/src/**/*.test.ts` serve as the regression — running them to completion N times exercises the new pool topology. Sidecar pytest, Pester, and Playwright are unaffected (different harnesses; no change).

### Manual acceptance walkthrough

Run on the dev machine where the symptom was originally observed (16 logical CPUs, 64 GB RAM, Windows 11). Lower-spec machines reproduce the green-path identically but won't have hit the original crash to begin with.

1. **Cold server suite.**
   - `cd server && npm run test`
   - Expected: completes green. Wall time roughly 60–90 s cold (was ~40–60 s with 16 workers when no crash occurred, so expect a ~30–50% slowdown — that's the explicit trade for stability).
   - Expected NOT to see: "Worker exited unexpectedly" / tinypool errors. If observed, the cap is too high — drop to `maxForks: 2` and re-validate.
2. **Cold frontend suite.**
   - `npm run test`
   - Expected: completes green at roughly the same wall time as before the change (no concurrency change on this side).
3. **Full verify run end-to-end.**
   - `npm run verify` (typecheck + frontend + server + Pester + sidecar + Playwright + build).
   - Expected: completes green. Worst-case wall time should still finish well inside 10 min on a warm cache.
4. **Forced flake — confirm `retry: 1` recovers a single transient.**
   - Add a temporary throw to any test that fires once-per-process (e.g., a `let firstRun = true; if (firstRun) { firstRun = false; throw new Error('synthetic'); }` in any leaf test).
   - Run that suite. Expected: Vitest reports the test as passing with `(retry 1/1)` visible in the reporter output. Verify run as a whole returns green.
   - Remove the synthetic throw.
5. **Forced flake — confirm `retry: 1` does NOT mask a real failure.**
   - Add a permanent throw to the same test (no `firstRun` gate). Run the suite.
   - Expected: Vitest reports the test as failed even after retry. Verify run as a whole returns non-zero.
   - Remove the throw.
6. **Pre-push end-to-end.**
   - On a feature branch with one trivial commit, run `git push -u origin <branch>`. The pre-push hook fires `npm run verify`.
   - Expected: the push goes through green. If a worker dies anyway, file a follow-up to drop `maxForks` to 2 and reopen the plan to amend invariant #1.

## Out of scope

- **The deeper "verify cache" lever.** Tracked separately as `docs/BACKLOG.md` → Must #1 ("Verify-cache for cheap retries after flake"). That work makes the *cost* of any future flake near-zero by skipping unchanged-input steps on retry; this plan makes the *probability* of flakes lower. Both are independently valuable; this plan ships now because it's a 10-line config change with immediate payoff.
- **Migrating the server suite off subprocess-spawning ffmpeg tests.** A separate "use a stub ffmpeg" or "use the @ffmpeg-installer wasm port" effort would remove the underlying pressure entirely, but it's a much bigger lift (rewrite of `server/src/tts/mp3.ts:exec` and the four export pipelines) and trades real-world coverage for synthetic. Out of scope here.
- **Switching to Vitest's `pool: 'vmThreads'` or `pool: 'vmForks'`.** These pools reuse the JS context across tests, which can amplify cross-test contamination. The server suite has slices, in-memory stores, and module-level caches that would need auditing first. Wake this if test wall time becomes the bottleneck after the verify-cache lands (Must #1).
- **CI integration for the test suite.** Tracked as `docs/BACKLOG.md` → Could #1. Once `verify` runs in GitHub Actions, the pool cap may need a CI-specific override (CI runners typically have 2–4 cores, so `maxForks: 4` is already correct; no anticipated change). This plan does not block the CI work.

## Ship notes

- Shipped 2026-05-18 on branch `chore/test-vitest-pool-tuning`.
- Symptom that motivated the plan: pre-push on docs-only branch `docs/docs-plan-44-pr-hygiene` failed with `Worker exited unexpectedly` after 815/851 server tests passed. Retrying the identical commit re-ran the entire 6-step `verify` pipeline for nothing.
- Two config edits: `server/vitest.config.ts` (pool cap + retry) and `vitest.config.ts` (retry only). No code changes outside `vitest.config.ts` files. No test additions (framework-config change; existing suites serve as regression).
- One follow-up filed: `docs/BACKLOG.md` Must #1 — verify-cache lever for cheap post-flake retries. Independent of this plan; sequenced after it because tightening the probability of flakes is cheaper than caching state through them.
