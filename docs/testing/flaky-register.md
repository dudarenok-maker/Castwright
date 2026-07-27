# Flaky-test register

Tests quarantined out of the gating suites into the non-gating lane
(`npm run test:quarantine`). A row here is a debt: the test does not gate
releases until it is rewritten deterministically and graduated back.
Empty register = done. See the rewrite playbook in
`docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md`.

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|

_Empty — no tests are currently quarantined._

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
