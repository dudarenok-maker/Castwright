# Flaky-test release hardening — design

- **Status:** draft
- **Date:** 2026-06-17
- **Author:** Castwright maintainer + Claude
- **Scope:** Test infrastructure + CI wiring. No production *behavior* changes;
  minimal test-seam dependency injection in production files (an injectable
  clock / scheduler / cache) is permitted **only** where it carries zero runtime
  behavior change and is the cleanest path to determinism (see Non-goals).

## Problem

A release tag fires `release.yml`, whose `publish` job is gated on four legs:
`verify` (Ubuntu full), `cross-os-verify` (macOS + Windows = `verify:quick` →
`test:all`), `mobile-e2e`, and `companion-apk-build`. **Any** red leg blocks the
tag from publishing.

Timing/contention-sensitive tests blow their per-test budgets under CPU
**and disk-I/O** contention on shared CI runners — worst on macOS (10× billed,
slowest runner, most-contended filesystem). When that happens at a release tag,
the whole tag fails to publish; the only recovery is to re-run the full
(macOS-billed) battery. This burned **two separate v1.8.0 cut attempts** (#875).

The most recent offender (`server/src/routes/analysis-pipelining.test.ts`,
"rolling roster" Case 2) is exhibit A but **not** a one-off:

- **What actually fails is *runtime*, not correctness.** The assertions are
  already deterministic — they use trace **array insertion order**
  (`trace.indexOf` / `slice` / `findIndex`) under the pinned
  `STAGE2_CONCURRENCY=1`, NOT wall-clock timing. (`CallTrace.startedAt` is
  recorded but **never asserted on** — verified.) The flake is that the test
  **drives the whole `runMainAnalyzerJob` to completion**, polling for a
  dispatch *event* via a `setTimeout` budget loop (`waitFor`, line 344), and
  every chapter completion does a **real atomic `saveAnalysisCache` write** to a
  shared `CACHE_DIR` (with OneDrive/AV EPERM retry-with-backoff). Under load the
  drive-to-completion + that disk path balloon past the budget. Quiet box:
  <600 ms. Loaded macOS runner: >180 s. The 30 s→90 s→180 s budget-bump history
  is the smell of fighting the symptom.
- **Coverage status (corrected after review):** the *roster fold itself* is
  **already** unit-covered — `mergeRosterChapter` and `buildInterimCast` are
  exported and tested in `analysis.test.ts` (its "skips chapters missing from
  the chapterCast map" case is exactly Case 2's `not.toContain('ch12-char')`).
  What is **NOT** independently covered is the **watermark→snapshot timing
  coupling** — that the roster snapshot is taken at the *instant* the watermark
  releases chapter K, so it folds exactly chapters 1..K+LAG. That coupling lives
  in inline closures inside `runMainAnalyzerJob` (`rosterSnapshotFn`,
  `getPhase1Stage1Snapshot`, the dispatch gate — none exported), so making it
  deterministically unit-testable needs a small **extraction** (a permitted
  test-seam; see Non-goals + Wave 2). `phase-watermark.test.ts` covers the
  numeric watermark in isolation but has no concept of rosters.
- **Current blast radius is already shifting.** Case 2 carries
  `it.skipIf(process.env.CI)` since #875, so on CI it's *already* skipped — its
  release-gate risk today is ~zero. The live pain is now (a) **local pre-push**
  (the 363 s hang the user hit, CI-skip doesn't help locally) and (b) **Cases
  1/3/4/5 + the plan-118 regression, which share the identical
  drive-to-completion shape but are NOT skipped** — they run on CI under a 30 s
  budget and are the next release-blockers in waiting.
- `vitest.config.slow.ts` already pins these to a single fork (`maxWorkers: 1`)
  with `retry: 1` — and Case 2 still blew both cuts *at* `maxWorkers=1`. So the
  contention knobs are exhausted, and worker-count is NOT the axis (the disk/CPU
  contention is) — which constrains what a valid fix and acceptance bar look like.

So two independent things make this awful, and both must be fixed:

1. **Blast radius** — a single flaky test can block an entire release.
2. **Fragility** — tests depend on wall-clock budgets and real I/O under load
   instead of on deterministic events.

### The two flake classes

**Class A — Server timing/contention tests** (`test:server` + `test:server-slow`):

- *Sub-shape A1 — real-timer poll / drive-to-completion.* `analysis-pipelining.test.ts`
  awaits a full pipelined run and polls ordering via `setTimeout`. Runtime
  scales with runner load.
- *Sub-shape A2 — tmpdir / mock / in-`beforeAll`-server races.* The other slow
  files (`book-state`, `chapters-restructure`, `generation`,
  `generation-boundary-recycle`, `pdf-real`, `setup-readiness.route`,
  `kokoro-install.route`, `venv-bootstrap.route`, `gemini`) race on
  `mkdtempSync` tmpdirs, cross-file `vi.mock` contamination, and fake HTTP
  servers stood up in `beforeAll` under parallel-fork pressure.

**Class B — E2E / Playwright** (`test:e2e`, `test:e2e:mobile`):

- Port contention (Vite mock-mode port reuse), Windows `headless_shell` process
  leaks contaminating back-to-back runs, dev cold-start herd, font/render timing
  drift. Several of these were patched historically (ops-698 self-hosted fonts,
  `e2e/global-teardown.ts` proc sweep) but the *class* remains live.
- **Scope honesty:** on the *release* path, e2e runs **only on Ubuntu** (`verify`
  leg + `mobile-e2e` leg); `cross-os-verify` (macOS/Windows) runs `verify:quick`
  = `test:all`, which **excludes** e2e. So the Windows proc-leak sub-class
  **cannot block a release** — it bites **local pre-push** (`npm run verify` on
  the dev's Windows box). Class B is therefore in scope as **local pre-push
  reliability** work (explicitly requested), not as a release-gate blocker. The
  Ubuntu e2e flakes (cold-start herd, port reuse) *can* affect the release legs.

## Goals & success criteria

1. **Structural guarantee.** No timing/contention-sensitive test can block a
   release tag. A flake becomes a *visible non-gating signal*, never a *gate*.
   Verifiable: a deliberately-failing quarantined test does not fail the
   `publish` job's dependency set.
2. **Genuinely deterministic tests.** Every quarantined test is rewritten to
   assert its real invariant on the event sequence — never on **wall-clock
   budgets, real-timer polling, or real disk/network I/O in the assertion
   path**. (Disambiguation: the *in-test* `STAGE2_CONCURRENCY` pin stays — the
   ordering invariant legitimately requires it; the enemy is wall-clock/I/O
   under load, not the controlled in-test concurrency.) Each rewrite graduates
   back onto the gate. **Verifiable (strengthened per review M4):** the rewritten
   test has **zero awaits on real disk/network in its assertion path** (only
   deterministic events + a generous deadlock-backstop timeout) and completes in
   a small bounded microtask-drain time; flat-across-`--maxWorkers` and
   busy-loop-invariance are *secondary* signals only — they're insufficient on
   their own because the production flake occurred *at* `maxWorkers=1` and is
   driven by shared-`CACHE_DIR` I/O, not worker count.
3. **Anti-regression.** A documented pattern + an automated guardrail so a new
   `it.skipIf(process.env.CI)` / budgeted-poll / `waitForTimeout` flake cannot
   quietly creep back in. **Verifiable: the guardrail fails the `lint` step
   (pre-push + CI) on a planted violation** — note it runs at pre-push/CI, *not*
   pre-commit (see Layer 3 for why the hooks-tier home doesn't work).
4. **Register reaches zero** across both classes. The quarantine lane is empty
   at the finish line (or holds only genuinely-hard cases, each with a tracking
   issue and an explicit rationale).

## Non-goals

- **No production *behavior* changes** (pipeline logic, analyzer models, TTS,
  route semantics). The *only* production edits permitted are **test-seam
  dependency injection** — e.g. an injectable clock/scheduler, or a cache
  interface that a test can back with an in-memory impl — and only when (a) the
  default runtime path is byte-for-byte unchanged, (b) it's the cleanest route
  to determinism, and (c) it's covered by the existing production tests. Any
  such seam is called out in its wave's PR. (Relaxes the original hard "tests
  only" rule, which collided with the determinism goal for drive-to-completion
  tests — see C2 in the review history.)
- **No auto-retry as a gating mechanism.** Auto-retry masks real regressions and
  burns macOS minutes. At most `--retry=1` *inside the non-gating lane* (and the
  slow config already has it).
- No broad test-framework migration (stay on vitest + Playwright).
- No attempt to make the *production* analysis run faster — this is about tests.

## Architecture

Three layers. Layer 1 (the safety net) lands first and is permanent. Layer 2
(the real work) is the bulk of the effort and burns the register down to zero.
Layer 3 (the guardrail) keeps it from regressing.

### Layer 1 — Non-gating quarantine lane

A flake that's been *identified* must be decoupled from the release gate
immediately, via one consistent mechanism per harness (no scattered ad-hoc
`it.skipIf`).

**Vitest (frontend + server).** A shared helper centralizes quarantine:

```ts
// src/test/quarantine.ts (and re-exported for server tests)
// A quarantined test runs ONLY in the explicit lane (RUN_QUARANTINE=1).
// EVERY gating run — local pre-push AND CI — leaves the flag unset → skipped.
export const quarantinedIt = process.env.RUN_QUARANTINE ? it : it.skip;
export const quarantinedDescribe = process.env.RUN_QUARANTINE ? describe : describe.skip;
```

- Replaces raw `it.skipIf(process.env.CI)`. A quarantined test is `quarantinedIt('…')`
  and **must** carry a `// QUARANTINED(#NN): <symptom>` comment linking its
  register row. The helper lives at `src/test/quarantine.ts` and is **imported**
  by each test — **never** added to `setupFiles` (it must eval after vitest's
  globals are registered; review m3).
- Gating commands (`test`, `test:server`, `test:server-slow`) run with the flag
  unset → quarantined tests skip with a banner.
- **Deliberate behavior change from `skipIf(process.env.CI)` (review M1):** the
  old form still ran the flake **locally** (CI unset), so a local pre-push could
  still hang on the 363 s contention timeout. `quarantinedIt` skips in **all**
  gating runs, local included — that's the point of "never blocked again." The
  only coverage given up while a test sits in quarantine is the **timing-coupling
  integration signal** (the *fold* is already unit-covered — see Problem); that
  gap is **bounded to one wave** (Wave 1→2) and closed by Wave 2's deterministic
  rewrite + extracted coupling unit test. Not recovered by running the flake.
- A new **non-gating** command runs them. It **must** use `cross-env` (the
  `RUN_QUARANTINE=1 vitest` Bash form fails on the Windows dev box — review C1)
  and run **all three** configs in **full** (no `--changed`, or the lane
  silently runs zero — `analysis-pipelining` lives in the *slow* config):
  ```jsonc
  "test:quarantine":
    "cross-env RUN_QUARANTINE=1 npm run test &&
     cross-env RUN_QUARANTINE=1 npm --prefix server run test &&
     cross-env RUN_QUARANTINE=1 npm --prefix server run test:slow"
  ```
  `RUN_QUARANTINE` is a real process-env var (inherited by vitest forks), **not**
  a vitest `env:` config key.

**Playwright (e2e).** Use Playwright's native tag support (`{ tag: '@quarantine' }`):

- Quarantined tests carry the `@quarantine` tag.
- **Gating runs must OR both exclusions into ONE `--grep-invert` regex**
  (review M2 — two `--grep-invert` flags are *last-wins*; a second flag silently
  **drops** the existing `"visual baselines"` exclusion and re-races the
  `--workers=1` visual specs into the parallel battery). So `test:e2e` becomes
  `--grep-invert="visual baselines|@quarantine"`.
- A non-gating `test:e2e:quarantine` runs `--grep=@quarantine`.

**Register.** `docs/testing/flaky-register.md` — one table:

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|

CLAUDE.md gets a one-line pointer to the register and the helper. The register
shrinking to zero *is* the definition of done.

**CI wiring.**

- `release.yml`: the `publish` job's `needs:` set is unchanged; the gating legs
  already skip quarantined tests (flag unset — verified: `verify` runs
  `npm run verify`, `cross-os-verify` runs `verify:quick`=`test:all`, neither
  sets `RUN_QUARANTINE`). Add an **optional, non-blocking** quarantine job
  (`continue-on-error: true`, NOT in `publish`'s `needs:`) that runs the literal
  `npm run test:quarantine` script (which itself runs all three configs — do
  **not** hand-roll a `test:server`-shaped command, which runs the *fast* config
  and exercises zero quarantined server tests, false-greening; review M3).
  **Acceptance check:** the always-failing fixture quarantined test must appear
  as *run-and-failed* in this job's log, never *skipped* — proving the lane
  actually executes.
- `verify.yml`: add a non-gating quarantine step (or accept that quarantined
  tests simply don't run on the gating path; the dedicated lane covers
  visibility). Keep it out of any required status check.
- Local: `npm run verify` / pre-push exclude quarantined tests automatically
  (flag unset). A separate `npm run test:quarantine` is available on demand.

### Layer 2 — Deterministic rewrite (the burn-down)

The playbook, applied to every quarantined test until the register is empty.

**Class A1 — real-timer poll + real I/O → event-driven + in-memory.**
1. **Kill the real-timer poll.** Replace `waitFor(setTimeout…)` with event-driven
   deferreds: extend the fixture with `whenDispatched(phase, chapterId)`. **The
   deferred must be pre-armed synchronously at fixture-build time** (resolve
   immediately if the trace entry already exists, else on push) — otherwise an
   awaiter registered *after* an intervening `await` misses the event and hangs
   to the backstop (review m1). Await the *event*, not the clock.
2. **Keep the assertions as-is** — they already use deterministic trace
   insertion order under the pinned `STAGE2_CONCURRENCY=1`; do **not** "fix"
   ordering assertions (there are none on wall-clock — review M1). Keep the
   in-test concurrency pin.
3. **Outer per-test timeout = deadlock backstop only** (generous, e.g. 30 s),
   never a perf budget. With the poll and I/O gone, a healthy run drains in a few
   ms; a red test means a real deadlock/logic break.
4. **Remove real disk I/O from the assertion path (review M2 — carefully).** The
   per-chapter `saveAnalysisCache` atomic write to the shared `CACHE_DIR` is a
   *load-sensitive* contributor (EPERM retry/backoff under contention) — but it
   is **also** the only integration coverage of the plan-88 concurrent
   same-tick rename race (`tmpSeq`). So: stub/inject the cache to in-memory for
   the *scheduling* tests **AND** add one dedicated, deterministic regression
   test for the same-tick cache-write race so that coverage is **not** silently
   dropped. Call this out as a named coverage trade in the Wave-2 PR. (Smaller
   fixtures too.)
5. **Make the watermark→snapshot coupling unit-testable (the real gap).** Extract
   `rosterSnapshotFn` / the Phase-1 dispatch gate out of the `runMainAnalyzerJob`
   closure into an exported, injectable function (a permitted behavior-neutral
   test-seam), then unit-test "snapshot at watermark-release K folds exactly
   1..K+LAG" deterministically. This — not a duplicate of the already-covered
   fold — is the coverage Case 2 uniquely provided.

**Class A2 — tmpdir / mock / server races → isolation.**
- Give each test its own uniquely-named tmpdir and tear it down deterministically;
  do not share module-global mocks across files (reset/restore in
  `afterEach`); move fake HTTP servers out of `beforeAll` racing where they
  contaminate siblings, or bind to an ephemeral port and await `listening`.
- Where a file is *pool-destabilising* rather than slow (e.g. `pdf-real`,
  `generation-boundary-recycle`), the fix is isolation correctness, not a bigger
  timeout. Once deterministic + isolated, evaluate whether it still needs to
  live in `test:server-slow` at all (graduating it back to the parallel tier
  shrinks wall-clock).

**Class B — E2E.**
- Each gating run uses a fresh, unique port (no reuse across back-to-back runs);
  ensure `global-teardown` sweeps leaked browser processes on Windows; replace
  any fixed `waitForTimeout` with state-based `expect(...).toPass()` / locator
  waits; keep fonts self-hosted (already done) so first paint isn't network-timed.
- Audit `e2e/**` for `waitForTimeout`, port literals, and missing teardown; fix
  or quarantine-then-fix each.

Each rewritten test **drops its quarantine tag/marker and rejoins the gate**, and
its register row is deleted in the same PR.

### Layer 3 — Anti-regression guardrail

**Home (corrected per review C2):** the guardrail runs in the **`lint` step**
(pre-push + CI), **not** pre-commit. The hooks-tier idea doesn't work: pre-commit
is scope-filtered (`verify:fast:scoped`) and the hooks/`test:hooks` scope never
fires on a server-test-only or e2e-only PR — the exact PRs a violation lands in.
`lint` (ESLint, `--max-warnings 0`) already globs all `*.ts(x)` and runs in
pre-push + the scoped CI `lint` leg, so it actually bites. (`lint` is not in the
fast/pre-commit tier; we accept the guardrail is a pre-push/CI gate, not
pre-commit — adding `lint` to the fast tier is a perf cost we decline.)

**What ESLint can mechanically enforce (`no-restricted-syntax`):**
- New `it.skipIf(process.env.CI)` / `test.skip(…process.env.CI…)` in
  `*.test.ts(x)` — a tractable `CallExpression`/`MemberExpression` selector.
- New `page.waitForTimeout(` in `e2e/**` — name-based, tractable.
- A large **inline per-test timeout literal** (e.g. `}, 180_000)`) in server
  `*.test.ts` — caps the budget-bump anti-pattern that a config-level backstop
  can't (the config `testTimeout` is overridden by an inline arg; review m3).
- The rule must be added in an ESLint override block that **includes** test files
  and a separate `e2e/**` block (the repo already relaxes rules for `*.test.ts`).

**What ESLint canNOT enforce (review M1):** a general "budgeted polling loop"
(`while(!cond)` + `Date.now()-start > budgetMs`) is a *semantic* pattern, not an
AST shape — and a blanket `WhileStatement`/`setTimeout` ban false-positives on
legitimate loops and the bare `setTimeout(r,0)` single-tick yield (Case 3). So
this arm is **demoted** to (a) a targeted grep for the banned `waitFor`-budget
helper name in `server/src/**/*.test.ts`, plus (b) a documented review-checklist
item — explicitly a heuristic, not a guarantee.

**Ratchet (review m4):** the rule lands in **Wave 5, after every migration**, so
zero existing violations remain — otherwise `lint --max-warnings 0` hard-fails
the first push. Ships with a planted-violation test proving it fails closed.

## Sequencing (waves / PRs)

Each wave is its own branch + PR, independently `npm run verify`-green.

0. **Wave 0 — Reproduce + baseline (review M2/M4).** The exact macOS-10× 180 s
   timeout isn't locally reproducible, so target the *mechanism*: show the
   offender's runtime **scales with induced load** (busy-loop pinning CPU;
   induced `CACHE_DIR` I/O contention — **not** just `--maxWorkers`, which is
   already pinned to 1 where it flaked). Capture baselines. The acceptance
   property for a rewrite is **no real I/O in the assertion path + bounded
   microtask-drain time** (load-invariance is a secondary signal). Also produce
   the **evidence list** scoping Wave 3 (which slow files *actually* failed vs.
   merely precautionary) **and** which of Cases 1/3/4/5 + the plan-118 case have
   flaked on CI (they're un-quarantined today). *Outcome: a repro harness + an
   evidence-ranked target list across all five pipelining cases and the slow
   files.*
1. **Wave 1 — Lane + register + quarantine the live siblings (insurance).**
   `quarantine.ts` helper (vitest, `cross-env` lane script, all three configs) +
   Playwright single-regex tag convention + `flaky-register.md` +
   `test:quarantine` / `test:e2e:quarantine` + non-gating CI job. Migrate Case 2
   off `skipIf` onto the helper. **Per-test redundancy check (review C1):** the
   roster *fold* is already unit-covered, so no duplicate unit test is needed;
   the only interim gap is the watermark→snapshot *timing coupling*, bounded to
   Wave 1→2. **Also quarantine any of Cases 1/3/4/5 + plan-118 that the Wave 0
   evidence shows flaking on CI (review M3)** — the structural guarantee is
   incomplete if identical-shape siblings keep gating. *Outcome: no
   timing-flake-shaped pipelining test can block a release; ad-hoc skip gone.*
2. **Wave 2 — Class A1 burn-down (proof of pattern).** Rewrite the pipelining
   family deterministically (pre-armed event deferreds; in-memory cache
   injection); **extract `rosterSnapshotFn`/the dispatch gate** and add the
   coupling unit test (Layer 2 step 5); **add the same-tick cache-write race
   regression test** (Layer 2 step 4). Each rewrite meets the Wave 0 acceptance
   bar; graduate them back onto the gate; document the playbook. *Outcome: the
   release-killer + its siblings genuinely test AND gate again; no coverage
   traded away silently.*
3. **Wave 3 — Class A2 burn-down (evidence-gated, review M3).** Only rewrite the
   slow files the Wave 0 evidence shows **actually flaked**; isolation-only files
   that never failed stay serialized (rewriting them is gold-plating). Graduate
   any rewritten file out of the slow tier. **Also fix the stale "5 hot files"
   comments** (`vitest.config.slow.ts:3`, `verify-cache.mjs:98` — the array now
   has 10; review m2) when touching these files. *Outcome: genuinely-flaky
   server tests are deterministic; precautionary ones left alone with a note.*
4. **Wave 4 — Class B (e2e) burn-down.** Audit `e2e/**` for `waitForTimeout`,
   port reuse, teardown gaps; fix or quarantine-then-fix. Prioritize the Ubuntu
   flakes (which can hit the release legs) over Windows-only proc leaks (local
   pre-push only). *Outcome: the e2e legs are deterministic.*
5. **Wave 5 — Guardrail + closeout.** Land the anti-regression check; confirm
   the register is empty (or only documented hard cases remain); update
   CLAUDE.md + INDEX; archive the plan.

Wave 1 delivers "never again" structurally on day one. Waves 2–4 deliver the
"actually fixed" mandate. Wave 5 makes it stick.

## Testing strategy (how we test the test infra)

- **The lane:** a fixture quarantined test that always fails, asserted to NOT
  fail the gating commands and to run in `test:quarantine`. (Removed or kept as
  a guarded self-test.)
- **Deterministic rewrites:** the primary bar is **no real disk/network await in
  the assertion path** + completion in a small bounded microtask-drain time
  (with the cache injected in-memory). Induced-CPU-load and varied-`--maxWorkers`
  runs are kept as *secondary* signals only — insufficient alone, because the
  production flake hit *at* `maxWorkers=1` on shared-`CACHE_DIR` I/O (review M4).
- **Guardrail:** a planted-violation test (a temp file with a banned pattern) is
  asserted to make the guardrail exit non-zero; a clean file passes.
- Standard `npm run verify` green on every wave.

## Risks & mitigations

- *Risk: quarantining hides a real regression (review C1).* Mitigation: a
  **per-test redundancy check** before quarantine — for the pipelining cases,
  the roster *fold* is already unit-covered (`mergeRosterChapter`,
  `buildInterimCast`); the only thing quarantine gives up is the
  watermark→snapshot *timing-coupling* integration signal, for a **bounded one
  wave** (Wave 1→2), after which the extracted coupling unit test (Wave 2)
  restores it permanently. The non-gating lane still runs the originals for
  visibility; the register forces a tracking issue per entry.
- *Risk: the rewrite trades away coverage (review M1/M2).* Mitigation: the
  assertions stay identical (already deterministic insertion-order — nothing on
  wall-clock to "fix"); the in-memory cache injection is paired with a dedicated
  same-tick-write race regression test so the `tmpSeq` coverage isn't dropped;
  both are called out explicitly in the Wave-2 PR.
- *Risk: the permitted test-seam DI (C2) creeps into a real behavior change.*
  Mitigation: each seam must leave the default runtime path byte-for-byte
  unchanged and be covered by existing production tests; it's called out in its
  PR and reviewed specifically for behavior neutrality. A test that would need a
  genuine behavior change to be deterministic stays quarantined (with an issue),
  not force-fit.
- *Risk: e2e flakes are environmental (Windows proc leaks) and resist a clean
  fix.* Mitigation: the lane absorbs them non-gating while fixed incrementally;
  the release e2e legs run on Ubuntu, so Windows-specific leakage is already off
  the publish path — that sub-class is local pre-push hygiene (Wave 4 priority
  is the Ubuntu flakes that can actually hit a release).

## Open questions

- **Quarantine lane on every tag vs. manual (review finding m4).** Running
  deliberately-slow tests on billed runners every tag costs minutes for little
  marginal signal. **Decision: Ubuntu-only, `continue-on-error`, on the tag**
  (cheap, gives release-time visibility) — revisit if the lane grows large
  enough that even Ubuntu minutes matter, in which case move it to manual
  dispatch / a weekly cron alongside `cross-os.yml`.
- For Class A2, decide per-file at rewrite time whether it graduates out of
  `test:server-slow` entirely or stays serialized — measured against the Wave 0
  baseline, not guessed.

## Provenance

This spec was hardened by **two rounds of adversarial review** (an inline pass
and two independent code-grounded subagents). The `C1`/`C2`/`M1`–`M4`/`m1`–`m4`
labels in the text are those findings. Notable corrections the second round
forced: the roster *fold* is already unit-covered (the real gap is the
watermark→snapshot timing coupling, needing an extraction); the flake is
drive-to-completion **+ real disk I/O**, not wall-clock-ordering assertions
(there are none); the cache cannot be blanket-stubbed without dropping the
`tmpSeq` race coverage; and Cases 1/3/4/5 share the flake shape but are
un-quarantined today, so Wave 1 must quarantine the flaking siblings too.
