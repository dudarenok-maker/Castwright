---
status: stable
shipped: 2026-05-18
owner: null
---

# 50 — Verify-cache for cheap retries after flake

> Status: stable
> Key files: `scripts/verify-cache.mjs`, `scripts/tests/verify-cache.test.mjs`, `package.json`
> URL surface: none (developer tooling)
> OpenAPI ops: none

## Benefit / Rationale

- **User (developer):** a transient flake on step N of the verify pipeline used to force a full re-run of steps 1..N-1 on the next push, even though their inputs hadn't changed. The cache makes the recovery cost ≈ one re-run of the step that actually failed (typically ~60s for the server suite) instead of ~6 min for the whole pipeline. Same lever helps the common edit-then-push loop: a single-file `server/src/` change re-runs only `typecheck`, `test:server`, and `build`; the rest skip with `[cached]`.
- **Technical:** the cache is per-step, derived from a SHA-256 of every input file the step legitimately reads (filtered from `git ls-files`) plus the relevant lockfile hashes plus a tool fingerprint where availability matters. No flag-flipping required from the developer; the cache is invisible until it skips something. Manual override via `npm run verify -- --no-cache`.
- **Architectural:** establishes a runner seam (`scripts/verify-cache.mjs`) where future per-step instrumentation can live (parallelism, opportunistic retries on first-fail, CI-side caching). Pairs with plan 45 (Vitest pool tuning + one-retry policy) — plan 45 lowered the flake _probability_; this plan drops the _cost_ of any remaining flake to near-zero.

## Architectural impact

- **New seam:** `scripts.verify` in `package.json` is now `node scripts/verify-cache.mjs`. The runner shells out to `npm run <step>` for each step in pipeline order, so the leaf scripts in `package.json` remain the single source of truth for what each step actually does. No duplication.
- **Invariant preserved (pre-push gate):** when every step's input hash misses the cache, the runner's output is functionally identical to the old `&&`-chain — same order, same exit-code-on-first-fail, same env. The cache is supposed to be UX-invisible; deviation would be a regression.
- **Test-harness expansion:** `scripts.test:hooks` widened from a single file to `node --test scripts/tests/*.test.mjs` so the new test file is discovered without a new harness.
- **Reversibility:** revert is a two-line `package.json` change (restore `verify` to the `&&` chain, narrow `test:hooks` back to one file) plus deleting `scripts/verify-cache.mjs` and its test. The cache file is gitignored so nothing leaks.

## Invariants to preserve

1. **Pipeline ordering** in `scripts/verify-cache.mjs` is exactly: `lint, typecheck, test:hooks, test, test:server, test:scripts, test:sidecar, test:e2e, build` — same order the old `&&` chain ran. Reordering would change which step gates which on a partial-green retry. (`scripts/verify-cache.mjs:23-115`)
2. **Per-step save on green only** — the cache is updated immediately after each step exits 0, not batched at end-of-run. A step-5 failure must leave steps 1-4's hashes persisted; the next retry must skip them. (`scripts/verify-cache.mjs:312-323`)
3. **`--no-cache` still updates the cache on green.** Bypass flag skips comparison but writes hashes on a clean run, so the manual override doesn't discard a good cache. (`scripts/verify-cache.mjs:124-128`, behaviour reachable via `decide` returning `'run'` while the post-step save logic is unconditional.)
4. **Schema-version invalidation.** Bumping the `SCHEMA_VERSION` constant in `scripts/verify-cache.mjs:17` invalidates every cache entry (escape hatch for algorithm changes — change the constant in the same PR as the hash-composition logic).
5. **Tool fingerprints for `test:scripts` and `test:sidecar`.** If a step's tool isn't installed (Pester missing / pytest venv unbootstrapped), the fingerprint string MUST capture that — otherwise a "passed by skipping" run gets cached as green and the step never runs once the tool is installed. (`scripts/verify-cache.mjs:235-265`)
6. **`git ls-files` is the file-source-of-truth.** If `git` is unreachable (rare — broken checkout), the runner runs uncached rather than guessing the file list. (`scripts/verify-cache.mjs:267-275, 296-298`)
7. **Conservative over-invalidation.** When a step legitimately consumes `src/**` (lint / typecheck / test / test:e2e / build), edits anywhere under `src/` invalidate it. Under-invalidation would be a correctness bug; over-invalidation is a UX nit and the flake-recovery use case is unaffected.

## Test plan

### Automated coverage

- `scripts/tests/verify-cache.test.mjs` — 21 node:test cases covering the pure logic:
  - **Hash composition:** determinism, stepName / schemaVer / fingerprint / lockfile participation, content-change invalidation.
  - **Decision logic:** cache hit → skip, miss → run, absent entry → run, `--no-cache` always runs.
  - **Persistence:** save/load round-trip (deep-equal), malformed JSON → empty default, missing file → empty default, stale schemaVersion → empty default, stale `.tmp` doesn't block save.
  - **Filtering:** `selectStepFiles` against POSIX path lists, brace-glob extension matching, extraFiles inclusion.
  - **Flags:** `parseFlags` recognizes `--no-cache` anywhere in argv.
  - **File hashing:** `hashFile` returns a stable sentinel for missing files (no throw); identical contents → identical hash.

`runPipeline` itself is exercised by the manual walkthrough below rather than via mocked-spawn unit tests — mocking nine `npm run` invocations would be slow and fragile, and the failure modes that matter (spawn fails, step returns non-zero, env propagation) are easier to catch by running the real pipeline.

### Manual acceptance walkthrough

Numbered against the BACKLOG acceptance criteria. Run on a clean working tree.

1. **#1 — clean tree, all run, cache populated.** Delete `.verify-cache.json`. Run `npm run verify`. Expect nine `[run] <step>` / `[pass] <step> (took Xs)` pairs. After completion, `.verify-cache.json` exists with nine entries.
2. **#2 — re-run no changes, all cached, under ~5s.** `npm run verify` again with nothing changed. Expect nine `[cached] <step> (input hash unchanged)` lines. Total elapsed dominated by file hashing (~tens of ms) + tool-fingerprint spawn for Pester / pytest (~a few hundred ms each).
3. **#3 — touch a file in `src/lib/`.** Append a comment to a tracked file under `src/lib/`. Re-run. Expect `[run]` on `lint`, `typecheck`, `test`, `test:e2e`, `build` (all legitimately consume `src/**`); `[cached]` on `test:hooks`, `test:server`, `test:scripts`, `test:sidecar`. NB: the original BACKLOG wording said "frontend `test` re-runs, others stay cached" — this plan reworded #3 to match the conservative input partition.
4. **#4 — touch `server/src/foo.ts`.** Append a comment to a tracked file in `server/src/`. Re-run. Expect `[run]` on `lint` (its repo-wide `**/*.{ts,...}` glob matches `server/src/**`), `typecheck`, `test:server`, `build`; `[cached]` on `test:hooks`, `test`, `test:scripts`, `test:sidecar`, `test:e2e`.
5. **#5 — force a flake, retry untouched.** Add a one-off env-driven throw to a single server-side test (e.g. `if (process.env.FORCE_FLAKE) throw new Error('flake');`). Run `FORCE_FLAKE=1 npm run verify` → `test:server` fails; cache is NOT updated for that step. Unset `FORCE_FLAKE` and re-run with no file edits. Expect `[cached]` for `lint`, `typecheck`, `test:hooks`, `test`, `test:scripts`, `test:sidecar`; `[run]` for `test:server` (cache miss — there's no green hash for it); then `[run]` for `test:e2e` and `build` (their position is downstream of test:server in the pipeline, which was previously the failure point; they had no green hash from the failed run either).
6. **#6 — `--no-cache` bypass.** `npm run verify -- --no-cache`. Expect every step to `[run]` regardless of cache contents. Cache is still updated on green.
7. **#7 — automated coverage runs.** `npm run test:hooks` discovers both `validate-commit-msg.test.mjs` and `verify-cache.test.mjs` via the glob; all cases pass.

## Out of scope

- **`verify:fast` (pre-commit gate).** The fast path already runs sub-5s warm on three steps; cache value is low. If the pattern proves itself for `verify`, a Should-tier follow-up extends the cache to `verify:fast`.
- **CI-side caching.** The cache lives at the repo root and is gitignored. Plan 49 (release packages) and the future Could #1 (CI workflow) extend this with `actions/cache` keys derived from the same input hashes — that's a separate plan.
- **Deeper tool fingerprints** (hashing the Pester module bytes, pip-freezing the venv `site-packages`). A user manually editing those would not trigger a re-run; out of scope for v1.
- **Parallel step execution.** Steps run sequentially today (matching the `&&` chain). The runner seam makes future parallelism cheap to add, but it's not in this plan.

## Ship notes

- **Shipped:** 2026-05-18
- **Merge commit:** `89a267b` (PR [#12](https://github.com/dudarenok-maker/AudioBook-Generator/pull/12))
- **Behaviour delta vs. spec:** none. All seven BACKLOG acceptance criteria met as written, with one wording refinement to #3 — the original "frontend `test` re-runs, every other step stays cached" became "every step that legitimately consumes `src/**` re-runs" (lint, typecheck, test, test:e2e, build), reflecting the conservative-over-invalidation rule that's safer than per-step glob narrowing. Documented in the Manual acceptance walkthrough above.
- **Measured:** cold verify ~120s (full 9 steps); warm verify ~1.0s (all `[cached]`). 21 new node:test cases run alongside the 38 commit-msg cases under the widened `test:hooks` glob.
- **Follow-up:** BACKLOG Should #3 — extend the cache to `verify:fast` (pre-commit gate). Not load-bearing; opportunistic.
