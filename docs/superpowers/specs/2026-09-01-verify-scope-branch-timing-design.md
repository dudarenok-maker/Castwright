---
status: draft
---

# Pre-push `--changed` scoping and lock-test timing margins

## Problem

Pre-push (`npm run verify:fast:branch`, `.husky/pre-push`) runs `test:server`
unscoped whenever the branch diff touches any server file — the full battery,
currently 8000+ tests, no `--changed` narrowing. On a box running several
concurrent worktree test batteries this took 70-80 minutes and failed three
times in a row, each time on a different timing-sensitive lock test unrelated
to the diff being pushed. Root cause of the failures, confirmed by rerunning
the flagged tests in isolation (they passed clean): `server/src/workspace/
file-lock.test.ts` races real `setTimeout` calls with thin margins (e.g. a
20ms lock-acquisition-timeout budget racing a 150-200ms holder) to assert
ordering, and 39+ concurrent node/python processes on the box introduced
enough scheduler jitter to occasionally flip that ordering.

Two independent problems, one incident:

1. **Volume** — pre-push runs far more tests locally than the diff could
   possibly affect.
2. **Fragility** — a handful of tests assert real-wall-clock ordering with
   margins too thin to survive this box's actual contention.

## Prior art this builds on

PR #2839 (merged, `main@75a86ed8`) added `--changed HEAD`-based narrowing to
**pre-commit** (`--scope-staged`) for the `test`/`test:server` legs, gated by
a positive allowlist (`diffSafeForChangedOnly`, `scripts/verify-cache.mjs`)
requiring every file in the diff sit under the step's own primary source root
(`src/**`, `server/src/**`) with a safe TS/JS extension — any diff outside
that (config, CSS, docs, mixed scope) falls back to a full run. It did **not**
extend the same substitution to `--scope-branch` (pre-push).

Cloud CI (`.github/workflows/verify.yml`) already does the equivalent
narrowing on every PR push: `npx vitest run --changed "$BASE"` for
`test:server`/`test:server-slow`, falling back to an unscoped `vitest run`
only when the diff hits `shared` scope (root manifest/lockfile). This spec
does not invent a new guarantee for pre-push — it makes pre-push mirror what
CI already does for the same diff.

## Decision

### A — extend `--changed` narrowing to `--scope-branch`

Widen the existing substitution gate in `runPipeline` (`scripts/
verify-cache.mjs`, currently `flags.scopeStaged && !scopeShared && scopeDiff
!== null && diffSafeForChangedOnly(step, scopeDiff)`) to also fire under
`flags.scopeBranch`. The allowlist (`diffSafeForChangedOnly`) is generic over
`diffFiles` and needs no change — the same conservative default holds: any
diff outside `src/**`/`server/src/**` with a safe extension still runs the
full suite locally, on both scoping paths.

**Base SHA, not `HEAD`.** The staged-scope substitution reuses the static
npm scripts `test:changed`/`test:server:changed` (`vitest run --changed
HEAD`), which is correct there because pre-commit's diff is uncommitted
changes vs. `HEAD`. At push time everything is committed, so `--changed
HEAD` would select nothing and vitest would silently exit 0 via
`passWithNoTests` — the exact silent-false-pass hazard PR #2839's pass-1
review caught in a different shape. Branch scope instead needs `--changed
<merge-base-with-main>`, mirroring CI's own `$BASE`. `branchDiffFiles`
(`scripts/verify-cache.mjs`) already computes this merge-base internally via
`git merge-base HEAD main` to produce its file list; it's refactored to also
return that SHA (or a sibling `branchMergeBase(cwd)` helper it and
`branchDiffFiles` both call, memoized so scope computation still costs one
git spawn) so `runPipeline` reuses the exact SHA already used to decide scope,
rather than a second, independently-timed `git merge-base` call.

**Invocation, not a new static script.** Because the base is dynamic, branch
scope can't reuse a fixed `test:server:changed` script string. `runStepProcess`
gains an optional `extraArgs` passthrough (`npm run <script> -- <extraArgs>`);
branch-scope substitution calls `runStepProcess(step.name, { extraArgs:
['--changed', baseSha], ... })` — i.e. `npm run test:server -- --changed
<sha>`, which becomes `vitest run --changed <sha>` after npm's arg
passthrough, the same shape CI already runs. `retryKey` stays `step.name`
either way, so the existing fork-pool-crash retry logic is untouched.

**Cache-write gate.** The existing rule — a `--changed`-only pass is never
written to the verify-cache (only a full run is, so a later cache hit can't
mean "a full run happened" when it didn't) — already keys off a single
`changedOnlyScript`-shaped truthy value in the per-step loop; it extends to
cover the branch-scope substitution with no change in shape, just a wider set
of inputs that can produce a truthy value.

**Docs.** CLAUDE.md's Commit gate section and `docs/features/
156-precommit-scope-contention.md` currently frame pre-push's unscoped
`test:server` run as the deliberate "full local safety net" that exists
*because* CI narrows its own runs. That framing is retired. Replacement:
local runs (pre-commit and pre-push both) narrow via `--changed` whenever the
diff is confined to source; cloud `verify.yml` — required, opt-out, runs
automatically on every PR push — is the authoritative full-suite gate; a
diff outside the allowlist (config/docs/CSS/mixed-scope) still gets a full
run locally too, so the common case of a source-only PR is the only one that
actually loses local full-suite coverage, and that PR gets full coverage
from CI before merge regardless.

### B — widen the real-timer margins that made this fail

`quarantinedIt` (`server/src/test-utils/quarantine.ts`) skips in **both**
gating lanes — local and CI. Wrong tool here: these tests are correct and
pass reliably in isolation (confirmed), so quarantining them would silently
drop real coverage from CI forever to solve a problem that's purely about
this box's local contention. Fix the actual fragility instead.

**Scope.** `server/src/workspace/file-lock.test.ts` is the confirmed
instance: several tests race a short lock-acquisition-timeout budget (20ms)
against a longer holder (30-200ms) to assert relative ordering. Widen every
such pair's margins — aim for roughly 10x headroom between the short
(timeout) value and the long (hold) value it's racing, e.g. a 20ms timeout
budget racing a 150ms holder becomes something like a 100ms budget racing an
800ms holder — tuned per test during implementation, verified by running the
file under `LOW_CONCURRENCY=1` plus an artificially loaded box if one is
available, or just by inspection of the margin ratio if not.

Apply the same fix to same-shape siblings in the lock-test family —
`server/src/workspace/cast-lock.test.ts` and `server/src/tts/
design-lock.test.ts` — since they share the same "two real timers racing for
an ordering assertion" pattern over the same underlying lock primitive. This
is **not** a blanket pass over every `setTimeout` in the server test suite
(a repo-wide grep found 76 occurrences across 33 files); most of those are
plain "wait long enough for an async op" delays with no competing timer, and
are insensitive to jitter for correctness purposes — only widening them would
just make the suite slower for no gain. If implementation turns up another
file doing the same competing-timer-ordering shape, it's fixed in the same
round per CLAUDE.md's incidental-findings rule, not filed and deferred.

**What this does not do.** No switch to `vi.useFakeTimers()` / fake-timer
rewrite. The lock primitives under test (`withKeyLock`'s promise-chained
queue) have real async/microtask interleaving that a fake-timer rewrite would
need to get right across every existing case, including the deliberately
`retry: 0` deadlock/timeout-typing suites — higher blast radius than this
incident calls for. Worth revisiting only if margin-widening turns out not to
hold up.

## Testing

- `scripts/tests/verify-cache.test.mjs`: new cases pinning the branch-scope
  substitution (source-regex, mirroring the existing staged-scope tests from
  PR #2839) — the widened gate condition, the `extraArgs`/base-SHA wiring,
  and that the cache-write gate still excludes a branch-scope changed-only
  pass.
- `server/src/workspace/file-lock.test.ts` (and the two siblings, if their
  margins also move): no new test cases — the existing assertions are
  unchanged, only the millisecond constants widen. The margin choice is
  self-documenting via a short comment at each widened pair, matching this
  file's existing comment-heavy convention, so a future reader knows the
  headroom is deliberate and not an arbitrary number.
- Manual: run `npm run test:server -- --changed <some-older-sha>` locally
  once implemented, confirm it selects a proper subset and exits nonzero on a
  genuine failure (not just `passWithNoTests`-style silent 0).

## Out of scope

- Auditing all 76 `setTimeout`-in-server-test occurrences for margin safety —
  only the confirmed lock-ordering-race shape is in scope this round.
- Any change to the production `withKeyLock`/`file-lock.ts` timeout values —
  this is a test-fragility fix, not a behavior change.
- Extending `--changed` substitution to any step besides `test`/`test:server`
  (unchanged from PR #2839's scope).
