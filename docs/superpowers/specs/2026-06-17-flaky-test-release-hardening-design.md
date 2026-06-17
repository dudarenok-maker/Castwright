# Flaky-test release hardening — design

- **Status:** draft
- **Date:** 2026-06-17
- **Author:** Castwright maintainer + Claude
- **Scope:** Test infrastructure + CI wiring only. No production/runtime code changes.

## Problem

A release tag fires `release.yml`, whose `publish` job is gated on four legs:
`verify` (Ubuntu full), `cross-os-verify` (macOS + Windows = `verify:quick` →
`test:all`), `mobile-e2e`, and `companion-apk-build`. **Any** red leg blocks the
tag from publishing.

Timing/contention-sensitive tests blow their per-test budgets under CPU
contention on shared CI runners — worst on macOS (10× billed, slowest of the
three). When that happens at a release tag, the whole tag fails to publish; the
only recovery is to re-run the full (macOS-billed) battery. This has burned
**two separate v1.8.0 cut attempts** on the same test (#875) — hours and macOS
minutes each time.

The most recent offender (`server/src/routes/analysis-pipelining.test.ts`,
"rolling roster" case) is exhibit A but **not** a one-off:

- Its logic is correct and is *already* pinned deterministically by
  `phase-watermark.test.ts` + `select-analyzer.test.ts` in isolation. The
  end-to-end version is redundant *correctness* coverage whose value is "watch
  the contract engage in the production path" — a nice signal, not the only
  guard against a bug.
- It fails because it drives the **real** `runMainAnalyzerJob` pipeline to
  completion using **real timers** and polls for ordering with `setTimeout`
  (`waitFor`, line 344), asserting on wall-clock-ordered traces. Its runtime is
  therefore hostage to runner load. Quiet box: <600 ms. Loaded macOS runner:
  >180 s → timeout. The 30 s → 90 s → 180 s budget history is the smell of
  fighting a symptom.
- `vitest.config.slow.ts` already routes **10** hot files to a single fork with
  `retry: 1` — and the flake *still* fails both attempts. The contention knobs
  are exhausted.

So two independent things make this awful, and both must be fixed:

1. **Blast radius** — a single flaky test can block an entire release.
2. **Fragility** — tests depend on wall-clock budgets, scheduling order, and
   worker counts instead of on deterministic behavior.

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

**Class B — E2E / Playwright** (`test:e2e`, `test:e2e:mobile`, run by the release
gate via `verify`):

- Port contention (Vite mock-mode port reuse), Windows `headless_shell` process
  leaks contaminating back-to-back runs, dev cold-start herd, font/render timing
  drift. Several of these were patched historically (ops-698 self-hosted fonts,
  `e2e/global-teardown.ts` proc sweep) but the *class* remains live.

## Goals & success criteria

1. **Structural guarantee.** No timing/contention-sensitive test can block a
   release tag. A flake becomes a *visible non-gating signal*, never a *gate*.
   Verifiable: a deliberately-failing quarantined test does not fail the
   `publish` job's dependency set.
2. **Genuinely deterministic tests.** Every quarantined test is rewritten to
   assert its real invariant on the event sequence — never on wall-clock
   budgets, real-timer polling, or worker/concurrency counts — and graduated
   back onto the gate. Verifiable: the rewritten test passes under deliberately
   induced CPU load (e.g. a parallel busy-loop) and at varied worker counts.
3. **Anti-regression.** A documented pattern + an automated guardrail so a new
   `it.skipIf(process.env.CI)` / real-timer-poll flake cannot quietly creep
   back in. Verifiable: the guardrail fails CI on a planted violation.
4. **Register reaches zero** across both classes. The quarantine lane is empty
   at the finish line (or holds only genuinely-hard cases, each with a tracking
   issue and an explicit rationale).

## Non-goals

- No changes to production/runtime code (pipeline logic, analyzer models, TTS,
  routes). Tests + CI wiring only.
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
// A quarantined test runs ONLY when RUN_QUARANTINE is set (the non-gating lane).
// Gating suites (test, test:server, test:server-slow) leave the flag unset → skipped.
export const quarantinedIt = process.env.RUN_QUARANTINE ? it : it.skip;
export const quarantinedDescribe = process.env.RUN_QUARANTINE ? describe : describe.skip;
```

- Replaces raw `it.skipIf(process.env.CI)`. A quarantined test is `quarantinedIt('…')`
  and **must** carry a `// QUARANTINED(#NN): <symptom>` comment linking its
  register row.
- Gating commands (`test`, `test:server`, `test:server-slow`) run with the flag
  unset → quarantined tests skip with a banner.
- A new **non-gating** command runs them: `test:quarantine` sets
  `RUN_QUARANTINE=1` and runs the frontend + server vitest projects, reporting
  pass/fail without gating anything.

**Playwright (e2e).** Use Playwright's native tag support:

- Quarantined specs/tests carry the `@quarantine` tag.
- Gating runs add `--grep-invert=@quarantine` (alongside the existing
  `--grep-invert="visual baselines"`).
- A non-gating `test:e2e:quarantine` runs `--grep=@quarantine`.

**Register.** `docs/testing/flaky-register.md` — one table:

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|

CLAUDE.md gets a one-line pointer to the register and the helper. The register
shrinking to zero *is* the definition of done.

**CI wiring.**

- `release.yml`: the `publish` job's `needs:` set is unchanged in spirit but the
  gating legs run the quarantine-excluding commands (they already do, once the
  tests are tagged — `test:all` / `verify` skip quarantined tests because the
  flag is unset). Add an **optional, non-blocking** quarantine job
  (`continue-on-error: true`, NOT in `publish`'s `needs:`) for release-time
  visibility.
- `verify.yml`: add a non-gating quarantine step (or accept that quarantined
  tests simply don't run on the gating path; the dedicated lane covers
  visibility). Keep it out of any required status check.
- Local: `npm run verify` / pre-push exclude quarantined tests automatically
  (flag unset). A separate `npm run test:quarantine` is available on demand.

### Layer 2 — Deterministic rewrite (the burn-down)

The playbook, applied to every quarantined test until the register is empty.

**Class A1 — real-timer poll → event-driven.**
1. **Kill real-timer polling.** Replace `waitFor(setTimeout…)` with event-driven
   deferreds. Extend the existing pipeline fixture (it already has hold/release
   barriers) with `whenDispatched(phase, chapterId): Promise<void>` that
   resolves the instant the trace entry is pushed. Await the *event*, not the
   clock.
2. **Drive ordering with explicit barriers** so the sequence is deterministic
   regardless of scheduler or worker count.
3. **Never assert on emergent orderings** that only hold at a given concurrency.
   Pin concurrency in-test (the tests already set `STAGE2_CONCURRENCY`) *and*
   gate progress on barriers, not on "what the pool happened to do".
4. **Outer per-test timeout = deadlock backstop only** (generous, e.g. 30 s),
   never a perf budget. A healthy run completes as fast as the microtask queue
   drains; under load it's slower but still passes. A red test means a real
   deadlock/logic break.
5. **Trim real work that doesn't serve the invariant** — smaller fixtures; keep
   real on-disk cache only where it keeps the test honest about write paths.

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

An automated check, wired into pre-commit/pre-push (and the hooks test tier),
that **rejects**:

- New `it.skipIf(process.env.CI)` / `test.skip(... process.env.CI ...)` in
  `*.test.ts(x)` — quarantine must go through `quarantinedIt` + a register row.
- New `setTimeout`-based polling (`waitFor`-style) in server `*.test.ts` outside
  an allowlisted deterministic helper.
- New `page.waitForTimeout(` in `e2e/**`.

Implementation: a small Node script in the `test:hooks` tier (grep-based, same
spirit as `validate-commit-msg.mjs`) OR an ESLint `no-restricted-syntax` rule.
Prefer the ESLint rule if it expresses the patterns cleanly (it runs in `lint`,
already a `verify` step); fall back to the hooks-tier script otherwise. The
guardrail ships with a planted-violation test proving it fails closed.

## Sequencing (waves / PRs)

Each wave is its own branch + PR, independently `npm run verify`-green.

1. **Wave 1 — Lane + register (insurance).** `quarantine.ts` helper (vitest) +
   Playwright tag convention + `flaky-register.md` + `test:quarantine` /
   `test:e2e:quarantine` scripts + non-gating CI job. Migrate the existing
   `analysis-pipelining` Case-2 `skipIf` onto the helper and register it.
   *Outcome: the structural guarantee exists; the ad-hoc skip is gone.*
2. **Wave 2 — Class A1 burn-down (proof of pattern).** Rewrite the 5-case
   `analysis-pipelining` family deterministically; graduate them back onto the
   gate; document the playbook. *Outcome: the proven release-killer genuinely
   tests AND gates again.*
3. **Wave 3 — Class A2 burn-down.** Audit + fix the remaining
   `test:server-slow` files (tmpdir/mock/server isolation). Graduate what no
   longer needs the slow tier. *Outcome: the server slow tier is deterministic.*
4. **Wave 4 — Class B (e2e) burn-down.** Audit `e2e/**` for `waitForTimeout`,
   port reuse, teardown gaps; fix or quarantine-then-fix.
   *Outcome: the e2e legs are deterministic.*
5. **Wave 5 — Guardrail + closeout.** Land the anti-regression check; confirm
   the register is empty; update CLAUDE.md + INDEX; archive the plan.

Wave 1 delivers "never again" structurally on day one. Waves 2–4 deliver the
"actually fixed" mandate. Wave 5 makes it stick.

## Testing strategy (how we test the test infra)

- **The lane:** a fixture quarantined test that always fails, asserted to NOT
  fail the gating commands and to run in `test:quarantine`. (Removed or kept as
  a guarded self-test.)
- **Deterministic rewrites:** each rewritten test must pass (a) under induced
  CPU load — wrap the test invocation with a parallel busy-loop or run the suite
  with `--maxWorkers` varied — and (b) at ≥2 different worker counts. This is
  the acceptance bar that proves contention-independence.
- **Guardrail:** a planted-violation test (a temp file with a banned pattern) is
  asserted to make the guardrail exit non-zero; a clean file passes.
- Standard `npm run verify` green on every wave.

## Risks & mitigations

- *Risk: quarantining hides a real regression.* Mitigation: only quarantine
  tests whose correctness is independently pinned by deterministic unit tests
  (true for analysis-pipelining); the non-gating lane still runs them for
  visibility; the register forces a tracking issue per entry.
- *Risk: the rewrite changes what's actually asserted.* Mitigation: the
  invariant (the `expect`s) stays identical; only the *wait mechanism* changes
  from clock-poll to event-await. Reviewed against the original assertions.
- *Risk: scope creep into production code.* Mitigation: hard non-goal; any test
  that can't be made deterministic without a production change is logged as a
  separate item, not folded in.
- *Risk: e2e flakes are environmental (Windows proc leaks) and resist a clean
  fix.* Mitigation: the lane absorbs them non-gating while fixed incrementally;
  the release gate's e2e leg runs on Ubuntu (`verify`), so Windows-specific e2e
  leakage is already off the publish path — focus there is local-run hygiene.

## Open questions

- Should the non-gating quarantine lane run on **every** release tag (visibility,
  small cost) or only on manual dispatch? (Leaning: run on the tag,
  `continue-on-error`, cheap on Ubuntu.)
- For Class A2, decide per-file at rewrite time whether it graduates out of
  `test:server-slow` entirely or stays serialized — measured, not guessed.
