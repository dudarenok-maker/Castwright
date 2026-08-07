# Flaky-test register

Tests quarantined out of the gating suites into the non-gating lane
(`npm run test:quarantine`). A row here is a debt: the test does not gate
releases until it is rewritten deterministically and graduated back.
Empty register = done. See the rewrite playbook in
`docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md`.

**Lane health (ops-32).** A row here being "quarantined, not gating" says
nothing about whether the test is actually flaky vs. permanently broken — a
single run can't tell those apart. `.github/workflows/quarantine-health.yml`
(`workflow_dispatch` + a weekly cron) runs `npm run quarantine:health`, which
re-runs each **vitest** (frontend/server) quarantined test several times and
reports, in the run's job summary, whether it's intermittent (genuinely
flaky — this register's framing holds), never-passes (broken — the row is
likely lying, e.g. #1854), not-found (stale row), or unknown (the runner
itself crashed/timed out too often to render a verdict — not a verdict about
the test). A Playwright (`e2e/**`) row is reported as not-covered — this
runner only exercises the vitest quarantine lane, not
`npm run test:e2e:quarantine` — check those manually. Non-blocking by design;
it never gates a merge.

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #1981 — a stale cast PUT does not erase a concurrently /assign-planted voice | `server/src/routes/book-state-preserve-voices.test.ts` | intermittent under full-suite box contention | Fails intermittently in a full `test:server` run under box contention; passes 7/7 in isolation. Observed 2026-08-07: `1 failed / 6741 passed`, `[fail] test:server (exit 1, took 746.6s)`. | #2226 | Not quarantined — still gates |

_Otherwise empty — no other tests are currently quarantined._

<!-- Graduated 2026-07-27: the two sleep-prevention wake-lock tests in
`server/src/routes/generation.test.ts` (#1854). They were never flaky. They
failed 100% of the time and had been red since the day they were quarantined
(9cf2e1e0) — the quarantine lane is non-gating, so nothing ever surfaced it,
and the row here recorded a "Windows tmpdir/fs contention" diagnosis the
evidence did not support (it also cited #399, a closed, unrelated sidecar
memory-leak issue). Root cause: a superagent `Request` is lazy — `.post().send()`
never sends; only `.then()`/`.end()` dispatches. Both tests hold the synth open
to assert mid-flight, so they awaited a promise resolved from inside the mocked
synth while their own request had never been dispatched. Deadlock. Fixed by
dispatching each request with `.then((r) => r)`. Cautionary note for the next
investigation: the original "passes reliably in isolation" claim, and my own
first several runs, were both artifacts of instrumentation — adding a
`p.then(...)` diagnostic to observe the hang was itself dispatching the request
and making the test pass. Measure with the probe removed. -->

<!-- Graduated 2026-06-30: `e2e/start-generation-tier-prompt.spec.ts` (#1178). The
"cold-load race" was three spec-local defects masked by implicit timing — the
"Approve cast" click firing before the cast slice hydrated (no modal), the case-D
guard premise broken by the fixture's pre-designed Eliza, and cases A/B driving a
brittle cast-design UI — plus a shared `goToAnalysing` lazy-chunk wait. Replaced
with explicit ready signals (`waitForQwenCastHydrated` / `waitForRouteReady`) and
store-seeded preconditions. See the commit for the full root-cause writeup. -->
