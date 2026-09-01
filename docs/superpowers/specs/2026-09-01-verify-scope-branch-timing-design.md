---
status: draft
---

# Local test scope, timing-margin fragility, and cloud e2e sharding

## Problem

Pre-push (`npm run verify:fast:branch`, `.husky/pre-push`) runs `test:server`
(and, on a frontend-touching diff, the frontend `test` leg) unscoped whenever
the branch diff touches any file in that leg's tree — the full battery,
currently 8000+ tests for `test:server` alone, no `--changed` narrowing. On a
box running several concurrent worktree test batteries this took 70-80
minutes and failed three times in a row, each time on a different
timing-sensitive lock test unrelated to the diff being pushed.
`server/src/workspace/file-lock.test.ts` has confirmed-fragile pairs — a
20ms lock-acquisition-timeout budget racing a 150-200ms holder to assert
ordering — that are unambiguously too thin to survive real scheduler jitter,
regardless of whether they were this specific incident's proximate cause; no
failure log from the three runs was captured, and the repo separately
documents fork-pool crashes (which retry the *entire* step up to 3x under
contention, `scripts/verify-cache.mjs`'s `MAX_POOL_ATTEMPTS`) as a plausible
independent or compounding cause of "70-80 minutes." This spec does not
resolve which explanation is right — see Decision B for how that's handled.

Four problems, addressed together because they're all "tests take too long
or fail for reasons unrelated to the change":

1. **Local volume** — pre-push runs far more tests locally than the diff
   could possibly affect, for every leg that can be diff-scoped.
2. **Fragility** — `file-lock.test.ts` has real-wall-clock-ordering pairs
   with margins too thin to survive contention, independent of whether
   they're proven to have caused this specific incident.
3. **Cloud e2e wall-clock** — separately raised: the e2e leg (the dominant
   single cost in cloud CI) is sharded 4-way today and can be sharded further.
4. **GPU/hardware coverage must not quietly ride along** — none of the above
   may be read as "CI now covers everything"; CI never has and still won't
   run anything GPU/hardware-dependent.

## Prior art, and two rounds of adversarial review

PR #2839 (merged, `main@75a86ed8`) added `--changed HEAD`-based narrowing to
**pre-commit** (`--scope-staged`) for the `test`/`test:server` legs, gated by
a positive allowlist (`diffSafeForChangedOnly`, `scripts/verify-cache.mjs`)
requiring every file in the diff sit under the step's own primary source root
(`src/**`, `server/src/**`) with a safe TS/JS extension. It did not extend
the substitution to `--scope-branch` (pre-push).

This spec went through two independent Opus review rounds before this
version. Both found real defects; the second round additionally **measured**
the design's core premise against this repo's actual git history rather than
asserting it, and that measurement changed the design materially. Summary,
because the reasoning matters for what shipped:

- **Round 1** found the originally-proposed invocation
  (`npm run test:server -- --changed <sha>`) doesn't work — `test:server` is
  `npm --prefix server run test`, a *nested* npm call, so the outer `--`
  never reaches the inner vitest; the SHA lands as a positional filename
  filter and the run fails with "No test files found." Fixed below by
  bypassing npm-script indirection and spawning the underlying command
  directly, the same shape CI's own step already uses.
- **Round 2 measured** `diffSafeForChangedOnly`'s real-world hit rate: **0 of
  the last 60 merged branches, 1 of 1360 real push-states**, because
  CLAUDE.md's own Before-shipping checklist mandates a
  `docs/release-notes-next.md`/plan-doc touch on nearly every non-trivial PR,
  which disqualifies the whole branch under the original allowlist. Owner
  decision: widen the allowlist to also tolerate `docs/**` and
  `RELEASE_NOTES.md` alongside real source changes — verified safe (grepped
  the whole repo for any `test`/`test:server`-scoped file reading a `docs/`
  path at runtime; the one hit, `scripts/tests/release-notes-gate.test.mjs`,
  lives under a different step entirely and is unaffected) — then
  **re-measured**: 0/60 → 3/60 (5%) for `test:server`. Real, but modest — the
  remaining disqualifying files in the same 60 branches (`server/tts-sidecar/
  main.py`, `openapi.yaml`+`api-types.ts` co-changes, cross-cutting
  `scripts/**`) are files that *should* disqualify narrowing, not artifacts
  of an overly strict allowlist, so this isn't pushed further.
- That measurement changes the shape of the whole spec: since local narrowing
  fires on only ~5% of real branches, pre-push keeps running the **full**
  suite on the other ~95%, same as today. The coverage exposure from giving
  up pre-push's blanket full-run guarantee is therefore small and bounded,
  not the wholesale policy reversal an earlier draft treated it as — which
  in turn means the earlier plan to force CI's own narrowing onto the same
  *strict* allowlist (so CI could serve as full replacement backstop) is the
  wrong fix: CI's current narrowing is looser (governed only by `shared`
  scope) and already works in production on far more PRs than 5%; forcing it
  onto the strict allowlist would regress CI's own performance to chase a
  now-small residual risk. **Dropped.** In its place: round 2 also surfaced a
  real, small, pre-existing CI bug independent of this whole allowlist
  question — see Decision A2.

## Decision

### A1 — extend `--changed` narrowing to `--scope-branch`, with a widened allowlist

Widen the substitution gate in `runPipeline` (`scripts/verify-cache.mjs`,
currently `flags.scopeStaged && !scopeShared && scopeDiff !== null &&
diffSafeForChangedOnly(step, scopeDiff)`) to also fire under
`flags.scopeBranch`, for both `CHANGED_ONLY_NPM_SCRIPT` entries — `test`
(frontend) and `test:server`.

**`diffSafeForChangedOnly` gets a second allowed category.** Alongside the
existing "every file under the step's own source root with a safe
extension" rule, a file matching `docs/**` or the root `RELEASE_NOTES.md` is
also allowed, unconditionally, on either scoping path (staged or branch) —
confirmed by measurement to raise the real-world hit rate (0/60 → 3/60 for
`test:server` over the last 60 merged branches) and confirmed safe by a
repo-wide grep: no file under `src/**` or `server/src/**`'s own test suites
reads anything under `docs/` at runtime. (The one file in the repo that does,
`scripts/tests/release-notes-gate.test.mjs`, belongs to `test:hooks`, a
different step this substitution never touches.) At least one file in the
diff must still be a real, safe-extension source file under the step's own
root — an all-docs diff never reaches this function, because
`stepTouchedByDiff` already filters the step out of scope entirely upstream.

**Base SHA, not `HEAD`.** The staged-scope substitution reuses the static
npm scripts `test:changed`/`test:server:changed` (`vitest run --changed
HEAD`), correct there because pre-commit's diff is uncommitted changes vs.
`HEAD`. At push time everything is committed, so `--changed HEAD` would
select nothing. Branch scope instead needs `--changed
<merge-base-with-main>`, the same shape CI's own `$BASE` uses (not the exact
same SHA — CI diffs against the fetched PR base, `branchDiffFiles` diffs
against local `main`; direction is fail-safe, a stale local `main` only
widens the diff and makes narrowing less likely, never silently more).
`branchDiffFiles` (`scripts/verify-cache.mjs`) already computes this
merge-base internally (one `git merge-base` spawn, then one `git diff` spawn)
to produce its file list; it's refactored to also return that SHA so
`runPipeline` reuses the one already used to decide scope. Its existing
callers/contract (it's independently exported and unit-tested) are preserved
— the return shape gains the SHA, doesn't lose the file list.

**Working-tree vs. committed diff.** `vitest --changed <sha>` diffs against
the *working tree*, not just `HEAD`. `branchDiffFiles`'s scope decision is
based on committed changes only. Pre-push does not require a clean tree, so
an uncommitted edit outside the allowlist (e.g. to `server/vitest.config.ts`)
would be invisible to the allowlist check but present in vitest's actual
selection — reopening the exact "diff touches this step but isn't
`--changed`-reachable" hazard the allowlist exists to close. Fixed by
checking `git status --porcelain` for the step's own tree alongside the
committed diff before allowing substitution; a dirty tree in scope forces the
full run, same conservative default as everywhere else in this design.

**Invocation — bypasses npm-script nesting.** `runStepProcess` gains a
direct-invocation mode: spawn `npx vitest run --changed <sha>` with `cwd` set
to the step's own directory (`server/` for `test:server`, repo root for
`test`), pinned to the local binary (`<cwd>/node_modules/.bin/vitest`,
falling back to `npx` only if that path doesn't exist) rather than bare
`npx vitest`, so a missing/un-junctioned `node_modules` fails loudly with
"vitest not found" as documented, instead of `npx` silently resolving a
different version from the registry. `retryKey` stays `step.name`, so the
existing fork-pool-crash retry logic (keyed on `step.name`, not on which
invocation shape ran) is untouched.

**The server suite's `pretest` preflight must not be silently dropped.**
`server/package.json` runs `node ../scripts/preflight-ffmpeg.cjs` as
`pretest`/`pretest:changed` before every existing `test:server` invocation
path. Bypassing the npm-script wrapper for direct invocation would silently
skip it. The direct-invocation path runs the same preflight script itself,
first, before spawning vitest — same check, same failure shape, just called
directly instead of via npm's lifecycle-script convention.

**Cache-write gate.** Unchanged in shape: a `--changed`-only pass (staged or
branch) is never written to the verify-cache; only a full run is.

### A2 — fix CI's `shared`-scope diffs actually forcing a full run (found in passing)

Not a new mechanism — a pre-existing bug, unrelated to A1's allowlist,
surfaced while reading `verify.yml` for this spec. `verify.yml`'s `test`/
`test:server` step bodies decide narrowed-vs-full only on whether `$BASE` is
set (`if [ -n "$BASE" ]; then --changed; else full; fi` — `$BASE` is only
empty on `workflow_dispatch`). The `shared` scope boolean
(`needs.detect.outputs.scopes.shared`, from `computeShared` — true for a
root-manifest/lockfile/`.github/actions/**` change) controls whether the
**job step runs at all**, but never reaches this narrowed-vs-full choice
**inside** the step body — so a `shared`-scope PR (e.g. touching only
`server/package-lock.json`) still runs `--changed "$BASE"`, and neither
`package-lock.json` nor `.github/actions/**` appears in
`server/vitest.config.ts`'s `forceRerunTriggers`, so that `--changed` call
can select zero tests and report green. Fix: thread the same `shared`
boolean already available in `needs.detect.outputs.scopes` into the step
body's condition — `shared` (or an empty `$BASE`) → full run; otherwise
`--changed "$BASE"`, unchanged from today. One conditional per affected step
(`test`, `test:server`/`test:server-slow`'s shared body). This is a defect
fix with one correct outcome, not a design decision, so it's fixed here
rather than filed.

### B — widen `file-lock.test.ts`'s confirmed-thin margins, as a no-regret hardening

Not claimed to be proven-confirmed as this specific incident's root cause —
no failure log from the three runs was captured, and the repo separately
documents fork-pool crashes retrying the whole step up to 3x under
contention (`MAX_POOL_ATTEMPTS`) as a plausible independent or compounding
cause that this fix does not touch. Shipped anyway because the fragility is
real and unambiguous on its own terms, independent of whether it explains
this incident.

**Scope, corrected to the three tests that actually race.**
`server/src/workspace/file-lock.test.ts`'s `withKeyLock acquisition timeout
(#2260)` `describe` block (`{ retry: 0 }`) has five tests; only three
actually race a short timeout against a real, finishing holder:

- `'does not poison the key after a timeout...'` — 20ms waiter budget vs.
  150ms holder.
- `'does not let a later caller barge past a still-running holder...'` —
  20ms vs. 200ms holder.
- `'leaves exactly one chains entry after a timeout...'` — 20ms vs. 150ms
  holder.

The other two in the same block are **not** touched: `'throws instead of
hanging when acquisition deadlocks...'` and the `withKeyLock typed timeout
error` block's test race a 20/50ms timeout against a holder that **never
releases** — there's no finishing-holder deadline to jitter past, so no
amount of contention flips their outcome, and the typed-error test asserts
the literal constant (`timeoutMs).toBe(20)`, message `'timed out after
20ms'`) that a mechanical margin-widening pass would otherwise break.
`'does not fire for legitimate contention comfortably under budget'` (20ms
hold vs. 500ms budget) already has enough headroom and isn't touched either.

`cast-lock.test.ts` and `design-lock.test.ts` were considered in an earlier
draft and dropped after being read in full: neither races two competing real
timers for an ordering assertion. `cast-lock.test.ts`'s timers are failure
sentinels (a 2000ms/1000ms ceiling racing critical sections that finish in
~0ms — three orders of magnitude of headroom, the opposite of thin) and its
2000ms sentinel is deliberately calibrated, by its own comment, to fire
before the production `withKeyLock` 10s budget; widening it would falsify
that relationship. `design-lock.test.ts` orders via explicit promise gates
against its own separate lock map (`design-lock.ts`, not `withKeyLock`) — its
few `setTimeout` uses are 5ms macrotask-flush ticks, not races. Neither is
touched.

**Fix is an absolute-gap floor, not a ratio.** A 20ms-vs-200ms pair is
already a 10x ratio and it's one of the three that's fragile — ratio isn't
the load-bearing quantity, the *absolute* gap between "when the short timer
could plausibly fire under jitter" and "when the long one finishes" is.
Target ≥500ms of absolute gap for each of the three pairs (a deliberately
generous floor — this box's actual jitter under the reported 39+-process
contention was never measured, so it's chosen with margin rather than
tightly calibrated), e.g. 20ms→50ms budget racing 150ms→700ms holder. Total
added wall-clock to the file: roughly +1.5s across the three widened
`await`s, serial, negligible.

**Search for other instances — corrected to the predicate that actually
explains why this file's failures were visible.** Not "any competing real
`setTimeout`" (141 occurrences across 52 files repo-wide, almost all plain
"wait long enough" delays with no race). The reason these three tests'
failures would surface as loud, specific red rather than being silently
absorbed is that their `describe` block opts out of the suite-wide `retry: 1`
(`{ retry: 0 }`, `#2028`'s documented reason: this file's module-level
`chains` state must never be silently rescued by a retry). The repo already
has the right instrument for finding this class rather than a fresh manual
grep: `server/vitest.config.ts`'s `retryHazardReporter` flags exactly the
"passed only because the suite-wide retry rescued it" case, and the file
records a prior `--retry=0` survey having been run across the suite. Rerun
that survey (or read its most recent output if still current) as part of
implementation to enumerate any other genuinely-masked-by-retry timing races,
rather than trusting a narrower manual grep to be exhaustive. Anything it
turns up in this same fragile-race shape is fixed in the same round per
CLAUDE.md's incidental-findings rule.

**What this does not do.** No switch to `vi.useFakeTimers()` — higher blast
radius than this fix calls for.

### C — `test:sidecar` (pytest): investigated, deliberately out of scope

`server/tts-sidecar/tests/` has **1136** `test_`-prefixed functions (`def
test_`/`async def test_`) across **83** files — an order of magnitude
smaller than `test:server`'s 8000+, and the CI-gating tier is
CPU-only/mocked, so it isn't the leg producing 70-80 minute runs. Unlike
vitest, pytest has no built-in `--changed`-equivalent; the closest analogues
(`pytest-testmon`, `pytest-picked`) are new dependencies meriting their own
evaluation. Left for a future round if `test:sidecar` itself ever becomes the
bottleneck. Unrelated to, and doesn't affect, the GPU/hardware carve-out
below — sidecar's weights-gated tests were already opt-in before this spec.

### D — increase cloud e2e sharding

`.github/workflows/verify.yml`'s `e2e` job shards `test:e2e` 4-way today
(`matrix.shard: [1, 2, 3, 4]`, `--shard=${{ matrix.shard }}/4`), cutting a
~16 min unsharded run to ~4 min/shard. Raise it to **8-way**: matrix array →
`[1, 2, 3, 4, 5, 6, 7, 8]`, both `--shard=N/4` references (the `test:e2e`
step only — `test:e2e:visual` isn't sharded today and stays that way) → `/8`,
job name label → `/8`. Standard GitHub-hosted runners are free/uncapped for
this public repo, so the real constraint is fixed per-shard cost that
doesn't shrink with more shards: `playwright.config.ts`'s `chromium` project
depends on the `warmup` project (Vite transform-cache warm-up), and
`webServer.reuseExistingServer: !CI` means every shard boots its own Vite dev
server — both run once per shard and double when shards double. `e2e/**/
*.spec.ts` is **137** files (not the ~110 the job's own 2026-07-10 comment
cites), so 8-way lands at ~17/shard. **Also fixed in the same diff**: two
further prose comments in `verify.yml` (the job's rationale block, and its
own header comment) that repeat both the stale `4`-way figure and the stale
`~110 spec files` count — a comment the change makes false is a chore this
repo's own rules already say is owed, not a separate follow-up. 8-way is a
reasonable stopping point before fixed per-shard cost dominates; exact number
confirmed with a real timing comparison during implementation, the same
method the original 4-way split's comment cites.

## Testing

- `scripts/tests/verify-cache.test.mjs`: source-regex cases (mirroring
  PR #2839's staged-scope tests) for the widened gate condition, the
  `docs/**`/`RELEASE_NOTES.md` allowlist addition, the dirty-working-tree
  check, and the cache-write exclusion for branch-scope changed-only passes.
  **Additionally** — a source-regex test can't catch a broken invocation,
  only a missing one (round 1's finding) — add a test that actually spawns
  the new direct-invocation path against a small disposable fixture repo (not
  this repo's own tree, to avoid the spawned vitest itself tripping
  `detectSiblingContention`'s process-count probe if this test ever ran
  inside a `test:hooks`-style pre-commit leg) confirming it forwards
  `--changed` correctly and actually narrows the selection.
- `.github/workflows/verify.yml`'s A2 fix: no unit test (workflow YAML) —
  verified by a manual `gh workflow run verify.yml --ref <branch>` dispatch
  against a deliberately root-lockfile-only diff, confirming the full suite
  runs rather than a narrowed `--changed` pass.
- `server/src/workspace/file-lock.test.ts`: no new test cases for the three
  widened pairs — existing assertions unchanged, only the millisecond
  constants widen, each with a short comment recording the new absolute gap.
- Manual: run the new direct-invocation command for both `test` and
  `test:server` against a real narrow branch locally, confirm it selects a
  proper subset and exits nonzero on a genuine failure.
- `.github/workflows/verify.yml`'s e2e shard change: verified by a manual
  `gh workflow run` dispatch, confirming 8 shard jobs appear and complete.

## Out of scope

- Auditing all 141 `setTimeout`-in-server-test occurrences for margin safety
  — only the three confirmed fragile-race-under-`retry:0` pairs are in
  scope; the rest is covered by rerunning the repo's own `retryHazardReporter`
  survey instead of a fresh manual sweep.
- Any change to the production `withKeyLock`/`file-lock.ts` timeout values —
  test-fragility fix, not a behavior change.
- `cast-lock.test.ts`, `design-lock.test.ts` — confirmed not to share the
  fragile shape; not touched.
- Forcing CI's own `--changed` narrowing onto the strict
  `diffSafeForChangedOnly` allowlist (the original Decision A2) — dropped
  after measurement showed it would regress CI's current, looser, working
  narrowing far more than the ~5%-hit-rate local change's residual risk
  justifies. `test:server-slow`'s CI narrowing is likewise unchanged.
- Extending the `--changed`-substitution mechanism to any step besides
  `test`/`test:server` — `test:sidecar` evaluated and deliberately deferred,
  see Decision C.
- Sharding `test:e2e:visual`, or changing its `--workers=1` anti-flake
  constraint.
- Any change to GPU/hardware-dependent test tooling (`test:golden-audio`,
  weights-gated sidecar tests, the on-box acceptance register) — never ran in
  CI, unaffected by anything in this spec, stays local-only.
- Determining, retroactively, which mechanism (timing fragility vs. fork-pool
  crash retries) actually caused the reported three-failure incident — no
  log was captured; Decision B ships as a no-regret hardening regardless.
