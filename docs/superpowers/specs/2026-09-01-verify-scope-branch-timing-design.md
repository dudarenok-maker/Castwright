---
status: draft
---

# Test timing-margin hardening, cloud e2e sharding, and subsystem-scoped dev scripts

## Problem

On a box running several concurrent worktree test batteries, a pre-push run
took 70-80 minutes and failed three times in a row, each time on a different
lock test in `server/src/workspace/file-lock.test.ts` unrelated to the diff
being pushed. No failure log from the three runs was captured. Two plausible,
non-exclusive explanations: (a) that file's `withKeyLock acquisition timeout`
tests race a 20ms timeout budget against a 150-200ms holder to assert
ordering, margins thin enough to look contention-sensitive on their face
(though see Decision B for a real counter-argument that they may not actually
be); (b) the repo separately documents fork-pool crashes, which retry the
*entire* step up to 3x under contention (`scripts/verify-cache.mjs`'s
`MAX_POOL_ATTEMPTS`), as independently capable of producing "70-80 minutes."
This spec does not resolve which explanation is right.

Four problems this round addresses, plus one it investigated and explicitly
does not fix:

1. **Fragility** — `file-lock.test.ts` has real-wall-clock-ordering pairs
   with margins thin enough to be worth widening as cheap insurance,
   independent of whether they're proven to have caused this incident (see
   Decision B — the fragility claim itself turned out to be contested, not
   confirmed).
2. **Cloud e2e wall-clock** — the e2e leg (the dominant single cost in cloud
   CI) is sharded 4-way today and can be sharded further.
3. **GPU/hardware coverage must not quietly ride along** — nothing here may
   be read as "CI now covers everything"; CI never has and still won't run
   anything GPU/hardware-dependent.
4. **No fast manual loop for "I'm only working in one subsystem"** — a
   developer who wants a quick local check of just the area they're touching
   has no way to do that short of the full leg or hand-typing a
   `vitest run <path>` invocation.
5. **Local pre-push volume — investigated, explicitly NOT fixed this round.**
   Pre-push runs `test`/`test:server` unscoped whenever the branch diff
   touches either leg's tree (8201 tests for `test:server` alone), no
   `--changed` narrowing. See "Considered and declined" below for why: the
   safe version of that narrowing measures at a real-world hit rate of
   effectively zero, so building it wasn't worth the machinery. The
   already-shipped sibling-contention throttle (PR #2839,
   `detectSiblingContention`) remains the actual mitigation for the
   concurrent-worktree-contention shape of this incident.

## Considered and declined: branch-scope `--changed` narrowing

PR #2839 (merged, `main@75a86ed8`) added `--changed HEAD`-based narrowing to
**pre-commit** (`--scope-staged`) for the `test`/`test:server` legs, gated by
a positive allowlist (`diffSafeForChangedOnly`, `scripts/verify-cache.mjs`)
requiring every file in the diff sit under the step's own primary source root
(`src/**`, `server/src/**`) with a safe TS/JS extension. Extending the same
substitution to `--scope-branch` (pre-push) was explored at length across
four rounds of adversarial review before being **declined**:

- **Round 1** found the originally-proposed invocation
  (`npm run test:server -- --changed <sha>`) doesn't work — `test:server` is
  `npm --prefix server run test`, a *nested* npm call, so the outer `--`
  never reaches the inner vitest; the SHA lands as a positional filename
  filter and the run fails with "No test files found."
- **Round 2 measured** `diffSafeForChangedOnly`'s real-world hit rate: **0 of
  the last 60 merged branches, 1 of 1360 real push-states**, because
  CLAUDE.md's own Before-shipping checklist mandates a
  `docs/release-notes-next.md`/plan-doc touch on nearly every non-trivial PR,
  which disqualifies the whole branch under the strict allowlist. An
  attempt to widen the allowlist to also tolerate `docs/**` alongside real
  source changes raised `test:server`'s hit rate to 3/60.
- **Round 3 found that widening unsafe**: a live counterexample
  (`src/lib/wiki-links.test.ts`, which reads `docs/wiki/*.md` at runtime with
  no `forceRerunTriggers` protection) meant the widened allowlist could
  silently skip that guard test on an ordinary `src/`+`docs/wiki/` diff — and
  measured per leg rather than combined, the widening's benefit was 3/60 for
  `test:server` and **zero** for `test`, the leg with the hole. Reverted back
  to PR #2839's original strict allowlist.
- **Round 4 confirmed the strict allowlist's real hit rate is effectively
  zero for the leg that matters**: 0/60 merged branches, 1/1360 push-states,
  for both `test` and `test:server`, under the restored strict allowlist.
  Building this out — a new direct-invocation spawn mode bypassing
  npm-script nesting, a `branchDiffFiles` contract change to carry a
  merge-base SHA, a repo-wide dirty-working-tree probe, hand-rolling npm's
  `pretest` lifecycle for the bypassed path, a spawning integration test —
  is real, non-trivial machinery to guard a path that fired on essentially
  none of this repo's actual branch history.

**Owner decision (this round): drop it.** The mismatch between the
machinery's cost and its measured benefit doesn't clear this repo's
"simplicity first" bar. Pre-push keeps running the full `test`/`test:server`
suite exactly as it does today — no regression, no change — and this
section exists so the idea isn't silently re-proposed without the
measurement that killed it. Revisiting it later would need either a
materially different allowlist design (see Decision A2's design-pass note
for the adjacent, still-open question of what property actually guarantees
`--changed` selects correctly) or evidence that this repo's branch shapes
have changed enough to move the hit rate.

## Decision A2 — CI's zero-test-selection hazard: real, found in passing, filed as a design-pass item

Independent of the narrowing question above — found while reading
`.github/workflows/verify.yml` during this investigation, not caused or
motivated by anything else in this spec. `verify.yml`'s `test`/`test:server`
step bodies decide narrowed-vs-full only on whether `$BASE` is set (`if [ -n
"$BASE" ]; then --changed; else full; fi` — `$BASE` is only empty on
`workflow_dispatch`), never on the `shared` scope boolean
(`needs.detect.outputs.scopes.shared`, from `computeShared` — true for a
root-manifest/lockfile/`.github/actions/**` change) that's already computed
and available. Two confirmed live instances where this lets a step run
`--changed "$BASE"` over a diff that selects zero tests and reports green:

1. A `shared`-scope PR (root `package.json`/`package-lock.json`,
   `.github/actions/**`) — `shared` is `true` but the step body never checks
   it.
2. A `server/package-lock.json`-only PR — `computeShared` only matches the
   *root* lockfile/manifest, so this diff is **not** `shared`; it reaches
   `step_test_server` through a separate `includeLockfiles` branch and stays
   narrowed regardless. Neither `package-lock.json` nor
   `server/package-lock.json` appears in `server/vitest.config.ts`'s
   `forceRerunTriggers`.

(An earlier draft of this spec also listed an `e2e/**`-only diff scheduling
the frontend step as a third instance — **that turned out not to be a real
hazard**: the frontend step also runs `npm run test:a11y` unconditionally,
so the step still does real work even when `--changed` selects nothing from
vitest. Dropped from the count.)

`test:server-slow` shares `test:server`'s step body (same `if:`, same
narrowing logic), so whatever the eventual fix is, it applies there too —
not a third independent instance, just a consequence of the shared body.

The correct unifying rule — something like "narrow only when every touched
file is covered by that config's own `forceRerunTriggers`" — is a real
design decision spanning both vitest configs, not a mechanical one-liner: a
naive `shared`-only fix (tried and rejected in an earlier draft) doesn't
cover instance 2. Per CLAUDE.md's incidental-findings rule, this is the one
class of finding that's filed rather than fixed in the same round — it needs
a design pass, and the decision it's waiting on is named here: *what
property of a diff actually guarantees `--changed <base>` selects a correct,
non-empty test set for a given vitest config, given that config's own
`forceRerunTriggers` list.* File as its own issue at implementation time;
this is a pre-existing hazard, unaffected by anything else in this spec —
no worse than before.

## Decision B — widen `file-lock.test.ts`'s thin-looking margins, as harmless hardening

Not claimed to be proven-confirmed as this specific incident's root cause,
and — after two more rounds of scrutiny — **not claimed to be confirmed
fragile at all**. Round 3 couldn't confirm actual fragility under
measurement (no repro attempted, no jitter figure captured). Round 4 raised
a more direct challenge: `file-lock.ts`'s acquisition timer is armed
synchronously at `withKeyLock` entry, the holder's `setTimeout` is armed one
microtask later, and Node fires expired timers in arrival order — meaning a
uniform event-loop stall delays both timers roughly together and *preserves*
the ordering these assertions depend on, rather than threatening to flip it.
Under that reading, these margins may not be a real defect at all. **Owner
decision: ship the widening anyway, as cheap (~+1.5s total), no-regret
insurance** — it costs almost nothing, and the theoretical case against
fragility isn't airtight either. This is explicitly not a claim that a
mechanism has been identified or a bug fixed; it's cheap insurance against
an unconfirmed but plausible-looking risk, stated as such rather than
oversold.

**Scope, corrected to the three tests that actually race.**
`server/src/workspace/file-lock.test.ts`'s `withKeyLock acquisition timeout
(#2260)` `describe` block (`{ retry: 0 }`) has five tests; only three
actually race a short timeout against a real, finishing holder:

- `'does not poison the key after a timeout...'` — 20ms waiter budget vs.
  150ms holder. **This test has a second timing pair** (a later `2000`ms
  budget racing the same holder, lines ~140-143) — widening the holder to
  ~700ms shrinks that second pair's own headroom from ~1850ms to ~1300ms;
  still comfortable, but not "only the first pair changes," and an
  implementer widening mechanically must account for both.
- `'does not let a later caller barge past a still-running holder...'` —
  20ms vs. 200ms holder.
- `'leaves exactly one chains entry after a timeout...'` — 20ms vs. 150ms
  holder.

The other two tests in the same `describe` block (`'throws instead of
hanging when acquisition deadlocks...'`, at line 82) plus the separate
`withKeyLock typed timeout error` block's test (a different `describe`, line
224) are **not** touched — both race a 20/50ms timeout against a holder that
**never releases** — there's no finishing-holder deadline to jitter past, so
no amount of contention flips their outcome, and the typed-error test
asserts the literal constant (`timeoutMs).toBe(20)`, message `'timed out
after 20ms'`) that a mechanical margin-widening pass would otherwise break.
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
already a 10x ratio and it's one of the three being widened — ratio isn't
the load-bearing quantity (if fragility applies at all — see above), the
*absolute* gap between "when the short timer could plausibly fire under
delay" and "when the long one finishes" is. Target ≥500ms of absolute gap
for each of the three pairs (a deliberately generous, unmeasured floor), e.g.
20ms→50ms budget racing 150ms→700ms holder. Total added wall-clock to the
file: roughly +1.5s across the three widened `await`s, serial, negligible.

**No further search for other instances.** The repo has exactly **four**
`{ retry: 0 }` blocks total — three in `file-lock.test.ts` (all covered
above), one in `design-lock.test.ts` (confirmed above not to race). That is
the complete population of "a timing test whose failure wouldn't be silently
absorbed by the suite-wide `retry: 1`," and all four have already been read
in full for this spec. `server/vitest.config.ts`'s `retryHazardReporter` is
**not** a usable instrument for finding more instances — it only reports
tests *rescued* by `retry: 1`, which by construction excludes every
`{ retry: 0 }` block; running it would survey the wrong population (and
would itself require the very 70-80-minute battery this spec is trying to
shrink). A blanket audit of the repo's 141 other `setTimeout`-in-server-test
occurrences is correspondingly out of scope — see Out of scope.

**What this does not do.** No switch to `vi.useFakeTimers()` — higher blast
radius than this fix calls for.

## Decision C — `test:sidecar` (pytest): investigated, deliberately out of scope

`server/tts-sidecar/tests/` has **1136** `test_`-prefixed functions (`def
test_`/`async def test_`) across **83** files — roughly 7x smaller than
`test:server`'s 8201, and the CI-gating tier is CPU-only/mocked, so it isn't
the leg producing 70-80 minute runs. Unlike vitest, pytest has no built-in
`--changed`-equivalent; the closest analogues (`pytest-testmon`,
`pytest-picked`) are new dependencies meriting their own evaluation. Left for
a future round if `test:sidecar` itself ever becomes the bottleneck.
Unrelated to, and doesn't affect, the GPU/hardware carve-out below —
sidecar's weights-gated tests were already opt-in before this spec.

## Decision D — increase cloud e2e sharding

`.github/workflows/verify.yml`'s `e2e` job shards `test:e2e` 4-way today
(`matrix.shard: [1, 2, 3, 4]`, `--shard=${{ matrix.shard }}/4`), cutting a
~16 min unsharded run to ~4 min/shard. Raise it to **8-way**: three live
sites — the matrix array → `[1, 2, 3, 4, 5, 6, 7, 8]`, the single
`--shard=N/4` reference in the `test:e2e` step → `/8` (`test:e2e:visual`
isn't sharded today and stays that way), and the job `name:` label → `/8`.

**Cost caveat, more complete than an earlier draft's.** Standard
GitHub-hosted Actions *minutes* are free/uncapped for this public repo, but
that's not the only constraint: (a) accounts have a **concurrent job slot**
ceiling separate from the minutes budget — 8 shards means 8 concurrent `e2e`
jobs (16 once `test:e2e:visual`'s job and others are counted alongside), and
if that ceiling is hit, shards queue rather than run in parallel, which
would blunt exactly the wall-clock win this decision is for; worth watching
after shipping, not assumed away. (b) The `e2e` job's `Checkout` and
`Setup Node + deps` steps carry **no `if:` scope condition** — they run on
every shard unconditionally, including on a docs-only PR where every other
leg in the job is scoped-off. Doubling the shard count doubles that fixed
overhead on **every PR in the repo**, not just e2e-touching ones. Combined
with `playwright.config.ts`'s `chromium` project depending on the `warmup`
project (Vite transform-cache warm-up) and `webServer.reuseExistingServer:
!CI` booting a fresh Vite dev server per shard — both run once per shard and
double when shards double — the real per-shard fixed cost is higher than
"just checkout and Playwright browser install."

`e2e/**/*.spec.ts` is **137** files (not the ~110 the job's own 2026-07-10
comment cites), so 8-way lands at ~17/shard. **Also fixed in the same
diff**: two further prose comments in `verify.yml` (the job's rationale
block, and its own header comment) that repeat both the stale `4`-way figure
and the stale `~110 spec files` count. 8-way is still a reasonable stopping
point given the fixed-cost caveats above; exact number confirmed with a real
timing comparison during implementation, the same method the original
4-way split's comment cites — and worth a follow-up look at actual PR
wall-clock (not just the e2e job's own duration) after it ships, given (a)
and (b) above.

## Decision E — manual subsystem-scoped npm scripts (developer convenience, not part of any gate)

Doesn't touch, and isn't gated by, anything else in this spec — the branch-
scope narrowing this was originally meant to complement was declined above,
so this stands on its own as the answer to Problem #4. Measured by actually
running `npx vitest list` (not a raw file-count grep, which earlier drafts
used and which overcounts by including files `test:server` itself excludes)
by top-level subdirectory:

- `test:server` (8201 tests total): `routes` 2314 tests/138 files, `tts`
  1908/123, `analyzer` 1321/73, `workspace` 766/57 — those four are 76.9% of
  the leg (6309/8201), everything else smaller.
- `test` (frontend, 4769 tests total): `components` 1192/112, `store`
  1130/52, `lib` 1046/102, `views` 828/29.

(`routes`'s file count is 138, not the 146 a raw `find` would report — 8 of
`server/src/routes/`'s test files are in `server/vitest.config.slow.ts`'s
`SLOW_FILES` list and excluded from `test:server` itself; a
`test:server:routes` script built the same way `test:server` runs naturally
excludes the same 8, which is the correct, matching behavior, not a gap —
worth a one-line comment so a developer isn't confused when the count looks
short of a raw file search.)

Add named npm scripts that just narrow `vitest run` to one subdirectory:

```
"test:server:routes":    "npm --prefix server run test -- src/routes",
"test:server:tts":       "npm --prefix server run test -- src/tts",
"test:server:analyzer":  "npm --prefix server run test -- src/analyzer",
"test:server:workspace": "npm --prefix server run test -- src/workspace",
"test:components": "vitest run src/components",
"test:store":       "vitest run src/store",
"test:lib":         "vitest run src/lib",
"test:views":       "vitest run src/views",
```

**Path note, corrected.** An earlier draft of these scripts prefixed the
server-side filter with `server/` (`-- server/src/routes`), copying the
path shape used from the *repo root*. `npm --prefix server run test` runs
with `cwd=server/`, so vitest's project root is already `server/` and the
filter must be **server-relative** (`src/routes`, not `server/src/routes`)
— verified by running it: the `server/`-prefixed form matches zero files and
exits 1 with "No test files found," the corrected form matches exactly the
138 files above. This was caught by round 4 review, not assumed from the
`test:server` name's surface resemblance to the path.

These are safe against the nested-npm argument-forwarding hazard round 1
found for a *different* invocation shape (`npm run <script> -- <args>`,
where a caller's `--` tries to reach through two levels of npm and fails)
because the filter path is baked into the script definition itself, not
appended by a caller at invocation time — one literal command line, same
shape the existing (working) `test:server` script already uses. Because
these invoke the server's real `test` script by name, `pretest`'s ffmpeg
preflight still runs automatically via npm's normal lifecycle-script
convention — nothing to wire separately.

**Deliberately not added to `STEPS[]`, not scope-gated, not cached, not part
of any hook.** These are opt-in, manual, developer-run commands — exactly
the same status `npm run verify:fast` or `npm run test:all` already have.
No safety guarantee is being made about what they cover (a `routes/` change
that breaks something in `workspace/` or `store/` isn't caught by
`test:server:routes` alone — that's what the full leg and CI are for); they
exist purely to make the common "I'm working in one area, give me a fast
local loop" case fast.

Only the four biggest subdirectories per leg are wired — the rest are
already small enough that running the full leg or a plain
`vitest run <dir>` by hand is fine without a named script.

## Testing

- `server/src/workspace/file-lock.test.ts`: no new test cases for the three
  widened pairs — existing assertions unchanged, only the millisecond
  constants widen, each with a short comment recording the new absolute gap.
- `.github/workflows/verify.yml`'s e2e shard change: verified by a manual
  `gh workflow run` dispatch, confirming 8 shard jobs appear and complete;
  also spot-check actual PR wall-clock once live, given Decision D's cost
  caveats.
- Decision E's scripts: no automated test (they carry no correctness
  guarantee to pin — see Decision E's own note). Verified by running each
  once locally and confirming it selects only its subdirectory's tests (and
  specifically that the corrected server-relative paths actually match —
  the path bug round 4 found is exactly the kind of thing that must be
  checked by running the command, not inferred). CLAUDE.md's Commands
  section gets a bullet listing them.
- Decision A2: no test this round — filed as an issue, not implemented.

## Out of scope

- Extending `--changed` narrowing to `--scope-branch` (pre-push) at all —
  see "Considered and declined" above.
- Auditing all 141 `setTimeout`-in-server-test occurrences for margin safety
  — the complete relevant population is the four `{ retry: 0 }` blocks
  already covered by Decision B; see that section's "No further search"
  note.
- Any change to the production `withKeyLock`/`file-lock.ts` timeout values —
  test-fragility fix, not a behavior change.
- `cast-lock.test.ts`, `design-lock.test.ts` — confirmed not to share the
  fragile shape; not touched.
- Fixing CI's zero-test-selection hazard — Decision A2, filed as a
  design-pass item this round rather than fixed.
- Extending any `--changed`-substitution mechanism to `test:sidecar` —
  evaluated and deliberately deferred, see Decision C.
- Sharding `test:e2e:visual`, or changing its `--workers=1` anti-flake
  constraint.
- Any change to GPU/hardware-dependent test tooling (`test:golden-audio`,
  weights-gated sidecar tests, the on-box acceptance register) — never ran
  in CI, unaffected by anything in this spec, stays local-only.
- Determining, retroactively, which mechanism (timing fragility vs.
  fork-pool crash retries, or something else entirely) actually caused the
  reported three-failure incident — no log was captured; Decision B ships as
  harmless insurance regardless, not as a diagnosed fix.
