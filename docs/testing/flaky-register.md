# Flaky-test register

Tests quarantined out of the gating suites into the non-gating lane
(`npm run test:quarantine`), or still gating and tracked here as known-flaky
pending that move. A row here is a debt: the test does not gate releases
once quarantined, until it is rewritten deterministically and graduated
back.
Empty register = done. See the rewrite playbook in
`docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md`.

**Quarantined column convention.** The "Quarantined" cell must be one of:
- Starts with "Quarantined" (e.g., `Quarantined`, `Quarantined (2026-08-01)`, `Quarantined — routes through ...`)
- Bare YYYY-MM-DD date (e.g., `2026-08-01`)
- Starts with "Not quarantined" (e.g., `Not quarantined — still gates`)
Any other value will cause `npm run quarantine:health` to report a parse failure.

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
| #2235 — revokes the older same-format manifest when a re-export of the same format finishes | `server/src/routes/export.test.ts` | intermittent under full-suite box contention | Fails on its first attempt and passes on retry inside a full `npm run test:server` run; surfaced only as a `[retry-hazard]` warning because vitest's `retry:1` absorbs it. Observed 2026-08-11 in the `dbcf36c5` pre-commit run (506 files / 7079 tests passed). | #2235 | Quarantined — routes through `quarantinedIt` (2026-08-13); runs only under `RUN_QUARANTINE=1` |
| #3917 — C3: collectProcessSnapshot returns real, plausibly-shaped rows from a real Win32_Process query | `scripts/tests/reap-stale-batteries.test.mjs` | host-unresponsive skip (not a flake of the test) | On a host too loaded to answer, the real `Get-CimInstance Win32_Process` query times out (two 15s attempts, 31.9s). The test now separates a slow host from a slow query: a one-row control spawn is timed on every run; a fast control makes a timeout FAIL, a slow control reruns the collector (two 120s attempts, up to 240s) and asserts rows, FAILS if the rerun took >15s and >3x the control, and only a slow control AND a rerun that also times out skips. Residual: a query that hangs outright on a slow-control host still skips. Observed on Windows in Castwright#3917. | #3917 | Not quarantined — still gates; skips only when the host is shown unresponsive |

_Otherwise empty — no other tests are currently quarantined or tracked here._

<!-- Graduated 2026-10-17: `server/src/routes/generation.test.ts` ::
"two GENUINELY concurrent chapter renders leave rerecordRtf/verifyRtf null for
both ..." (#3700). The row recorded a suspected race between the HTTP 200 and the
per-chapter stats record; that was WRONG, and this note exists so the next
investigator does not re-suspect it. `recordChapterThroughput` runs
synchronously before the response, so stats cannot lag the 200. The cross-os
log (run 38104373985, job 114366627758) shows the real cause one line above the
failure: chapter 1 FAILED with `ENOENT ... state.json` from
`finalize-chapter-write.ts` (`readJson`), and the route still answers 200 for a
failed chapter (failure rides the SSE stream), so no chapter-1 stats record was
ever written -> `byChapter.get(1)` undefined.

It was a PRODUCT race, not a test bug: finalizeChapterAudioWrite's state.json
stamp (and generation.ts's failure-path persist) was an UNLOCKED
read-modify-write, so two sibling chapters of one book finalizing together raced
(Windows: the read lands in the rename-over window -> ENOENT, failing the
chapter; elsewhere: a lost update dropping the first chapter's stamp). The
comment above it claimed "keyed by chapter id so concurrent sibling writes can't
clobber each other" - false for a whole-file rewrite.

Fixed by serialising both read-through-write blocks under a per-state.json leaf
lock (`withStateJsonLock`, workspace/file-lock.ts). Regression:
`server/src/audio/finalize-chapter-write-concurrent-state.test.ts` FORCES the
interleaving (parks the first state.json read until a second read is issued),
red before the fix (chapter stamp lost), green after. The original generation
test is unchanged and stays as the route-level check. Every other state.json
read-modify-write site now takes the same lock too (`state-json-lock.guard.test.ts`
fails the build on a new unlocked one). -->

<!-- Graduated 2026-08-12: `server/src/routes/script-review.test.ts` ::
"cancel immediately removes the job from the registry, so a same-scope retry
starts fresh instead of joining the doomed job" (#2262). Its row recorded the
class as UNDETERMINED — box contention vs. a real cancel-then-retry ordering
bug masked by `retry:1` — and that is why this note exists rather than a bare
deletion: the row carried an open question, and the next investigator should
find the answer, not the question again.

It was contention, established by MECHANISM rather than by a failure rate. The
synchronisation point was a bare 20ms wall-clock sleep before
`expect(runReview).toHaveBeenCalledTimes(2)` — the whole budget for the second
request to reach the analyzer. Positive control: shrinking 20ms -> 0ms on an
idle box reproduces the reported symptom verbatim. The feared reading is
structurally incapable of producing it: "the retry joins the doomed job" is a
PERMANENT absence of the second call, which fails at every budget and in
isolation, not a race a retry re-rolls — and `firstCall.release()` sits after
the assertion, so under the unfixed code the doomed job could never be cleaned
up in time for a late second call. Corroborated by 5 isolated `--retry=0` runs
and one full `src/routes` `--retry=0` run (128 files / 2092 tests), all green.

Fixed by polling the condition (`vi.waitFor`, 2000ms) instead of sleeping at
it, so the test is no longer timing-dependent. #2028's retry-hazard concern was
right to flag this test; it did not apply to this failure. -->

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
