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
timing-sensitive lock test unrelated to the diff being pushed. Root cause of
the failures, confirmed by rerunning the flagged tests in isolation (they
passed clean): `server/src/workspace/file-lock.test.ts` races real
`setTimeout` calls with thin margins (e.g. a 20ms lock-acquisition-timeout
budget racing a 150-200ms holder) to assert ordering, and 39+ concurrent
node/python processes on the box introduced enough scheduler jitter to
occasionally flip that ordering.

Four problems, addressed together because they're all "tests take too long
or fail for reasons unrelated to the change":

1. **Local volume** — pre-push runs far more tests locally than the diff
   could possibly affect, for every leg that can be diff-scoped.
2. **Fragility** — a handful of tests assert real-wall-clock ordering with
   margins too thin to survive this box's actual contention.
3. **Cloud e2e wall-clock** — separately raised: the e2e leg (the dominant
   single cost in cloud CI) is sharded 4-way today and can be sharded further.
4. **GPU/hardware coverage must not quietly ride along** — none of the above
   may be read as "CI now covers everything," because CI never has and still
   won't run anything GPU/hardware-dependent.

## Prior art this builds on, and what pass-1 review found wrong about it

PR #2839 (merged, `main@75a86ed8`) added `--changed HEAD`-based narrowing to
**pre-commit** (`--scope-staged`) for the `test`/`test:server` legs, gated by
a positive allowlist (`diffSafeForChangedOnly`, `scripts/verify-cache.mjs`)
requiring every file in the diff sit under the step's own primary source root
(`src/**`, `server/src/**`) with a safe TS/JS extension — any diff outside
that (config, CSS, docs, mixed scope) falls back to a full run. It did **not**
extend the same substitution to `--scope-branch` (pre-push).

Cloud CI (`.github/workflows/verify.yml`) already narrows on every PR push:
`npx vitest run --changed "$BASE"` for `test`/`test:server`/
`test:server-slow`, falling back to an unscoped `vitest run` only when the
diff hits `shared` scope (root manifest/lockfile). **A draft of this spec
claimed CI's narrowing meant CI could serve as "the authoritative full-suite
gate" once pre-push stopped being one — an adversarial review pass (Opus)
caught that this contradicts itself and, more importantly, contradicts
CLAUDE.md's actual documented invariant**: pre-push's unscoped run is
currently the *only* full-suite gate before merge, precisely because CI
already narrows. Retiring it without anything replacing its guarantee is a
real coverage regression, not a wash — and the review found a second,
independent problem: CI's own narrowing has no `diffSafeForChangedOnly`-style
allowlist, so it carries the identical "diff touches this step but
`--changed`'s dependency graph can't reach it" hazard PR #2839 hardened
against locally. That gap was tolerable while pre-push's full run backstopped
it; it stops being tolerable the moment CI becomes the only full-suite gate
left.

**Resolution (owner decision, this round):** accept that no unscoped
`test`/`test:server` run gates merge day-to-day once this ships — the
twice-weekly `cross-os.yml` cron and `release.yml`'s full `npm run verify`
remain the periodic backstops for the residual "reached by a non-import edge"
class — **on the condition that CI's own `--changed` narrowing gets the same
`diffSafeForChangedOnly` allowlist protection local narrowing has**, so the
gate CI is now solely responsible for is exactly as safe as the one it
replaces, just relocated. This is Decision A's second half, not a separate
follow-up.

The review pass also caught that the originally-proposed invocation mechanism
for branch-scope narrowing doesn't work at all (see Decision A below), that
two of the three "same-shape" test files named for Decision B don't actually
share the fragile pattern, that the proposed 10x-margin-ratio heuristic
optimizes the wrong quantity, and several stale counts. All incorporated
below; none of the numbers or file lists in this version are carried over
unverified from the draft.

## Decision

### A — extend `--changed` narrowing to `--scope-branch`, and give CI's own narrowing the same safety allowlist

**A1 — pre-push.** Widen the existing substitution gate in `runPipeline`
(`scripts/verify-cache.mjs`, currently `flags.scopeStaged && !scopeShared &&
scopeDiff !== null && diffSafeForChangedOnly(step, scopeDiff)`) to also fire
under `flags.scopeBranch`, for both `CHANGED_ONLY_NPM_SCRIPT` entries — `test`
(frontend) and `test:server`. The allowlist itself needs no change: any diff
outside `src/**`/`server/src/**` with a safe extension still runs the full
suite locally on either scoping path. Reviewer's question worth stating
plainly: this narrowing only fires when the *entire* branch diff since
merge-base sits under one safe root — a branch that also touches a config
file, doc, or crosses both `src/` and `server/src/` still gets the full local
run, same as today. That's expected, not a bug; the volume win applies to the
(common, not universal) case of a branch confined to one tree.

**Base SHA, not `HEAD`.** The staged-scope substitution reuses the static
npm scripts `test:changed`/`test:server:changed` (`vitest run --changed
HEAD`), correct there because pre-commit's diff is uncommitted changes vs.
`HEAD`. At push time everything is committed, so `--changed HEAD` would
select nothing. Branch scope instead needs `--changed
<merge-base-with-main>`, mirroring CI's own `$BASE`. `branchDiffFiles`
(`scripts/verify-cache.mjs`) already computes this merge-base internally
(one `git merge-base` spawn, then one `git diff` spawn) to produce its file
list; it's refactored to also return that SHA so `runPipeline` reuses the
exact one already used to decide scope, rather than a second,
independently-timed `git merge-base` call — this doesn't reduce today's git
spawn count (still two), it just avoids adding a third.

**Invocation — corrected.** The draft proposed `npm run test:server --
--changed <sha>`, assuming npm forwards `--changed` into the underlying
vitest call. **It doesn't, on this leg**: `test:server` is `npm --prefix
server run test` — a *nested* npm invocation — so the outer `--` is consumed
by the *outer* npm and never reaches the inner one; the SHA lands as a bare
positional argument to `vitest run`, which then tries to match it as a
filename filter and exits 1 with "No test files found." (Verified against
this repo's actual `package.json`/`server/package.json` scripts, not assumed.)
The frontend `test` script has no such nesting and the naive form would have
worked for it alone — which is exactly the kind of asymmetry that's easy to
miss if only one leg gets manually tried. Fix: bypass the npm-script
indirection for the branch-scope path entirely and spawn the underlying
command directly, the same shape CI's own step already runs successfully —
`npx vitest run --changed <sha>` with `cwd` set to the step's own directory
(`server/` for `test:server`, repo root for `test`). `runStepProcess` gains a
`directInvocation` mode alongside the existing npm-script mode so
`retryKey`/pool-crash-retry logic (keyed on `step.name`, unaffected by which
invocation shape ran) stays untouched.

**Cache-write gate.** Unchanged in shape: a `--changed`-only pass (staged or
branch) is never written to the verify-cache; only a full run is.

**A2 — CI's own `--changed` gets the allowlist too.** `scripts/ci-scope.mjs`
today emits one boolean per step (`step_test_server`, etc. — "does this leg's
scope intersect the diff at all") via `stepTouchedByDiff`, consumed by
`verify.yml`'s `if:` conditions to decide whether a job step *runs*; the
`--changed "$BASE"` vs. full-`vitest run` choice *inside* an in-scope step is
then hardcoded inline in the workflow YAML, keyed only on `shared`. Add a
second boolean per changed-only-eligible step —
`step_test_server_changed_safe: diffSafeForChangedOnly(testServerStep,
files)`, `step_test_changed_safe` likewise — computed in `ci-scope.mjs` from
the same `files` list already diffed against the PR base, using the same
exported `diffSafeForChangedOnly` function Decision A1 uses locally (single
source of truth, no duplicated logic). `verify.yml`'s `test`/`test:server`
step bodies gain a third branch: `shared` → full run (unchanged); else
`changed_safe` → `--changed "$BASE"` (unchanged shape, now gated); else → full
run (new — today this case silently narrows). `workflow_dispatch` and the
`ci-scope.mjs` crash fail-safe already default every scope boolean to `true`,
which correctly forces the full-run branch here too (a `true` scope with an
unset/`undefined` `changed_safe` boolean must read as "not safe" — verified
by how the new field composes with the existing `allTrue()`/fail-safe paths,
pinned by a test rather than inspection alone).

**Docs.** CLAUDE.md's Commit gate section and `docs/features/
156-precommit-scope-contention.md` currently state, as a decision, that
pre-push's unscoped run is deliberately the full local safety net *because*
CI narrows its own runs (plan 156's own acceptance item: "Pre-push runs the
full battery; only pre-commit is scope-filtered"). That decision is reversed,
not reframed — plan 156 gets a dated addendum recording the reversal and its
reasoning (the same treatment its 2026-09-01 addendum from PR #2839 already
used), and its acceptance criteria are updated to match, not left stale next
to contradicting prose. Replacement invariant, stated plainly: local runs
(pre-commit and pre-push) narrow via `--changed` whenever the diff is
confined to source; CI's own narrowing now carries the identical allowlist
protection (A2); the twice-weekly cross-OS cron and release-time full
`verify` are the periodic backstops for the narrow residual class no
`--changed`-based mechanism can close by construction (a source-only diff
that reaches a test through a non-import runtime edge). **None of this
extends to GPU/hardware-dependent testing** — `test:golden-audio` and any
weights-gated `test:sidecar` case were never run in CI (GitHub-hosted runners
have no GPU) and are unaffected by any of A1/A2; they remain opt-in, run
locally on demand via their existing flags, exactly as documented today. This
line is added explicitly to CLAUDE.md's Commit gate section so "CI is now the
full-suite gate" can't be misread as "CI covers hardware-dependent behavior
too" — it never did.

### B — widen the real-timer margins that made this fail

`quarantinedIt` (`server/src/test-utils/quarantine.ts`) skips in **both**
gating lanes — local and CI. Wrong tool: these tests are correct and pass
reliably in isolation, so quarantining would silently drop real coverage from
CI forever to solve a problem that's purely about this box's local
contention. Fix the fragility instead.

**Scope — corrected.** `server/src/workspace/file-lock.test.ts` is the only
confirmed instance: several tests in its two `{ retry: 0 }` `describe` blocks
race a short lock-acquisition-timeout budget (20ms) against a longer holder
(30-200ms) to assert relative ordering. **The draft also named
`cast-lock.test.ts` and `server/src/tts/design-lock.test.ts` as same-shape
siblings; review read both in full and found neither shares the pattern** —
`cast-lock.test.ts`'s timers are failure sentinels (a 2000ms/1000ms ceiling
racing critical sections that finish in ~0ms, three orders of magnitude of
headroom, the opposite of thin) and its 2000ms sentinel is *deliberately*
calibrated to fire well before the production `withKeyLock` 10s budget — its
own comment says so; `design-lock.test.ts` orders exclusively via explicit
promise gates, not competing timers, and doesn't call `withKeyLock` at all
(`design-lock.ts` has its own separate lock map). **Both are dropped from
this fix's scope entirely** — touching either would violate "Surgical
changes," and mechanically widening `cast-lock.test.ts`'s sentinel past the
production 10s budget it's deliberately calibrated under would change what
failure mode the test actually observes.

**The fix is an absolute-margin floor, not a ratio.** The draft's "~10x
headroom" framing is wrong on its own evidence: the existing 20ms-vs-200ms
pair is already a 10x ratio and it's one of the ones that flaked, while a
20ms-vs-30ms pair (a 1.5x ratio, comfortably passing in the same file today
because nothing times out on that path) shows ratio isn't the load-bearing
quantity — the *absolute* gap between "when the short timer fires" and "when
the long one finishes" is what has to survive scheduler jitter. Target: widen
each racing pair so the absolute gap is at least ~500ms (this box's observed
contention window under 39+ concurrent processes gave no precise jitter
figure, so 500ms is a deliberately generous floor, not a measured one) —
e.g. a 20ms timeout racing a 150ms holder becomes something like a 50ms
timeout racing a 600ms+ holder. Tuned per test during implementation; each
widened pair gets a short comment recording the new absolute gap and that
it's deliberate, matching this file's existing comment-heavy convention.

**Search predicate for "did we miss another instance," corrected.** Not "any
competing real `setTimeout`" (a repo-wide grep on that shape returns 141
occurrences across 52 files, mostly plain "wait long enough" delays with no
race and no jitter sensitivity). The predicate that actually explains why
this file's failures were *visible* rather than silently rescued is
**"competing real timers asserting ordering, inside a `{ retry: 0 }` block"**
— vitest's suite-wide `retry: 1` (`#2028`'s documented reason `file-lock.
test.ts` itself opts out of it) would otherwise absorb a one-off jitter flake
silently. If implementation finds another file matching that narrower
predicate, it's fixed in the same round per CLAUDE.md's incidental-findings
rule; a file with the broader "has a setTimeout" shape but ordinary retry
semantics is not in scope.

**What this does not do.** No switch to `vi.useFakeTimers()`. Higher blast
radius than this incident calls for; worth revisiting only if margin-widening
turns out not to hold up.

### C — `test:sidecar` (pytest): investigated, deliberately out of scope

Considered for the same narrowing since it's the third locally-gating test
leg. Sized it first: `server/tts-sidecar/tests/` has **1120** `test_*`
functions across **83** files — an order of magnitude smaller than
`test:server`'s 8000+, and the CI-gating tier is CPU-only/mocked (SKIPs+exits
0 on an unbootstrapped venv per CLAUDE.md), so it isn't the leg producing
70-80 minute runs or the lock-timing failures this incident is about. Unlike
vitest, pytest has no built-in `--changed`-equivalent; the closest analogues
(`pytest-testmon`, `pytest-picked`) are new dependencies with their own
correctness model, meriting their own evaluation rather than a small
extension of this spec's vitest-specific mechanism. Left for a future round
if `test:sidecar` itself ever becomes the bottleneck. This decision is
unrelated to, and doesn't affect, the GPU/hardware carve-out in Decision A's
Docs subsection — sidecar's weights-gated tests were already opt-in before
this spec and stay that way regardless of C's outcome.

### D — increase cloud e2e sharding

`.github/workflows/verify.yml`'s `e2e` job shards `test:e2e` 4-way today
(`matrix.shard: [1, 2, 3, 4]`, `--shard=${{ matrix.shard }}/4`), cutting a
~16 min unsharded run to ~4 min/shard. Raise it to **8-way**: matrix array →
`[1, 2, 3, 4, 5, 6, 7, 8]`, both `--shard=N/4` references (the `test:e2e`
step only — `test:e2e:visual` in the neighboring job isn't sharded today and
stays that way, out of scope) → `/8`, job name label → `/8`. Standard
GitHub-hosted runners are free/uncapped for this public repo, so the real
constraint is fixed per-shard cost that doesn't shrink with more shards —
**corrected from the draft**, that cost isn't just checkout/setup/Playwright
cache: `playwright.config.ts`'s `chromium` project depends on a `warmup`
project (the Vite transform-cache warm-up in `e2e/warmup.setup.ts`), and
`webServer.reuseExistingServer: !CI` means every shard boots its own Vite dev
server — both run once per shard and double when shards double. Spec count
corrected too: `e2e/**/*.spec.ts` is **137** files, not ~110, so 8-way is
~17/shard, not ~14. 8-way is still a reasonable stopping point before
per-shard fixed cost dominates, but the exact number is a tuning call to
confirm with a real timing comparison during implementation, the same method
the existing 4-way split's own comment cites — not something pinned exactly
here.

## Testing

- `scripts/tests/verify-cache.test.mjs`: source-regex cases (mirroring
  PR #2839's staged-scope tests) pinning the widened gate condition and the
  cache-write exclusion for branch-scope changed-only passes. **Additionally
  — the review's strongest finding was that source-regex tests can't catch a
  broken invocation, only a missing one**: add at least one test that
  actually spawns the new direct-invocation path (`npx vitest run --changed
  <sha>` with `cwd` set appropriately) against a disposable fixture — enough
  to prove the command as constructed actually forwards `--changed` and
  actually selects a subset, not just that the source text mentions the right
  strings. This is new territory for this file's existing "no process
  execution" convention and is called out explicitly rather than silently
  matching the old style.
- `scripts/ci-scope.mjs`'s existing test file: cases for the new
  `*_changed_safe` fields — safe diff, diff outside the allowlist, empty
  diff, and `workflow_dispatch`/fail-safe paths (must read as "not safe",
  pinned directly rather than inferred).
- `server/src/workspace/file-lock.test.ts`: no new test cases — existing
  assertions unchanged, only the millisecond constants widen, each with a
  comment recording the new absolute gap.
- Manual: run the new direct-invocation command for both `test` and
  `test:server` against a real narrow branch locally, confirm each selects a
  proper subset and exits nonzero on a genuine failure.
- `.github/workflows/verify.yml`'s e2e shard change and the A2 `changed_safe`
  branching: no unit test for the workflow YAML itself — verified by a
  manual `gh workflow run verify.yml --ref <branch>` dispatch, reading the
  job list (8 shard jobs, each completing) and confirming a
  known-`changed_safe`-diff PR actually took the narrowed path in the logs.

## Out of scope

- Auditing all 141 `setTimeout`-in-server-test occurrences for margin safety
  — only the confirmed lock-ordering-race-under-`retry:0` shape is in scope.
- Any change to the production `withKeyLock`/`file-lock.ts` timeout values —
  test-fragility fix, not a behavior change.
- `cast-lock.test.ts`, `design-lock.test.ts` — confirmed not to share the
  fragile shape; not touched.
- Extending the `--changed`-substitution *mechanism* to any step besides
  `test`/`test:server` (local or CI) — `test:sidecar` evaluated and
  deliberately deferred, see Decision C.
- Sharding `test:e2e:visual`, or changing its `--workers=1` anti-flake
  constraint.
- Any change to GPU/hardware-dependent test tooling (`test:golden-audio`,
  weights-gated sidecar tests, the on-box acceptance register) — explicitly
  unaffected, see Decision A's Docs subsection.
